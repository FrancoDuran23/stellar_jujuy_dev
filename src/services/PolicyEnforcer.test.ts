import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCostRaw,
  decidePolicy,
  createPolicyEnforcer,
  type ChannelBalancePort,
} from "./PolicyEnforcer.ts";
import type { ConnectivityProvider, SimUsage } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";

// Test pricing (raw units, 1e-7 USDC): 0.0125 USD/MB — the Telnyx data floor.
// 1 USD = 10_000_000 raw units.
const PRICE_PER_MB_RAW = 125_000n;
const LOW_BALANCE_BPS = 2000; // 20% of the deposit

// A deterministic channel: 100 USD deposit → 20 USD low watermark.
const BALANCE_100_USD = 1_000_000_000n;
const WATERMARK_20_USD = 200_000_000n;

const input = (balanceRaw: bigint, costRaw: bigint) =>
  ({ balanceRaw, costRaw, pricePerMbRaw: PRICE_PER_MB_RAW }) as const;

function session(override?: Partial<ConnectivitySession>): ConnectivitySession {
  return {
    id: "s1",
    userId: "u1",
    provider: "telnyx",
    simCardId: "sim-1",
    iccid: "iccid-1",
    channelId: "ch1",
    meteredBytes: 0n,
    carrierBytes: 0n,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...override,
  };
}

function balancePort(value: bigint): ChannelBalancePort {
  return { getChannelBalance: async () => value };
}

// --- computeCostRaw (ceiling MB, exact in BigInt) ---

test("computeCostRaw of 0 bytes is 0 raw units", () => {
  assert.equal(computeCostRaw(0n, PRICE_PER_MB_RAW), 0n);
});

test("computeCostRaw of exactly 1 MB equals the price", () => {
  assert.equal(computeCostRaw(1_000_000n, PRICE_PER_MB_RAW), PRICE_PER_MB_RAW);
});

test("computeCostRaw rounds up, so a session is never undercharged", () => {
  // 1 MB + 1 byte costs 1 raw unit more — the same ceilDiv contract the
  // payments component already uses (money.ts).
  assert.equal(computeCostRaw(1_000_001n, PRICE_PER_MB_RAW), PRICE_PER_MB_RAW + 1n);
});

test("computeCostRaw is exact for huge sessions (no float anywhere)", () => {
  const hugeBytes = 9_000_000_000_000n; // 9 TB
  const expected = (hugeBytes * PRICE_PER_MB_RAW) / 1_000_000n; // divisible → no rounding
  assert.equal(computeCostRaw(hugeBytes, PRICE_PER_MB_RAW), expected);
});

test("computeCostRaw rejects a non-positive price", () => {
  assert.throws(() => computeCostRaw(100n, 0n), RangeError);
});

// --- decidePolicy: the three lanes (deposit 100 USD, watermark 20 USD) ---

test("decidePolicy is noop while the remaining balance is above the low watermark", () => {
  // 500 MB → 6.25 USD spent → 93.75 USD remaining (> 20 USD watermark).
  const cost = computeCostRaw(500_000_000n, PRICE_PER_MB_RAW);
  const action = decidePolicy(input(BALANCE_100_USD, cost), LOW_BALANCE_BPS);

  assert.equal(action.kind, "noop");
  assert.equal(action.remainingRaw, 937_500_000n);
});

test("decidePolicy tightens the data limit once remaining <= 20% of the deposit", () => {
  // 6_800 MB → 85 USD spent → 15 USD remaining (below the 20 USD watermark).
  const cost = computeCostRaw(6_800_000_000n, PRICE_PER_MB_RAW);
  const action = decidePolicy(input(BALANCE_100_USD, cost), LOW_BALANCE_BPS);

  assert.equal(action.kind, "set_data_limit");
  if (action.kind === "set_data_limit") {
    assert.equal(action.remainingRaw, 150_000_000n);
    assert.equal(action.mb, 1200); // 15 USD / 0.0125 USD per MB
  }
});

test("decidePolicy triggers exactly at the watermark (<= 20%)", () => {
  // 6_400 MB → 80 USD spent → 20 USD remaining == watermark.
  const cost = computeCostRaw(6_400_000_000n, PRICE_PER_MB_RAW);
  const action = decidePolicy(input(BALANCE_100_USD, cost), LOW_BALANCE_BPS);

  assert.equal(action.kind, "set_data_limit");
  if (action.kind === "set_data_limit") {
    assert.equal(action.mb, 1600);
    assert.equal(action.remainingRaw, WATERMARK_20_USD);
  }
});

test("decidePolicy disables when the balance cannot cover the accrued cost", () => {
  // 800_000 MB → 100 USD spent == deposit → nothing left at all.
  const cost = computeCostRaw(800_000_000_000n, PRICE_PER_MB_RAW);
  const action = decidePolicy(input(BALANCE_100_USD, cost), LOW_BALANCE_BPS);

  assert.equal(action.kind, "disable");
  assert.equal(action.remainingRaw, 0n);
});

test("decidePolicy disables when not even 1 MB remains payable", () => {
  const action = decidePolicy(input(100_000n, 0n), LOW_BALANCE_BPS); // 0.01 USD
  assert.equal(action.kind, "disable");
});

test("decidePolicy clips a negative remaining balance to zero", () => {
  const cost = computeCostRaw(900_000_000_000n, PRICE_PER_MB_RAW); // 112.5 USD > deposit
  const action = decidePolicy(input(BALANCE_100_USD, cost), LOW_BALANCE_BPS);
  assert.equal(action.remainingRaw, 0n);
  assert.equal(action.kind, "disable");
});

test("decidePolicy respects a custom low watermark in basis points", () => {
  // 100% watermark → any remaining balance is at or below it.
  const action = decidePolicy(input(BALANCE_100_USD, 0n), 10000);
  assert.equal(action.kind, "set_data_limit");
});

test("decidePolicy rejects a non-positive price", () => {
  assert.throws(() => decidePolicy({ balanceRaw: 1n, costRaw: 0n, pricePerMbRaw: 0n }), RangeError);
});

// --- runOnce end-to-end with a fake provider + real balance port ---

function recorder(usage: SimUsage) {
  const calls = { disabled: [] as string[], limits: [] as { simCardId: string; mb: number }[] };
  const provider: ConnectivityProvider = {
    async purchaseEsim() {
      throw new Error("not reached");
    },
    async enable() {},
    async disable(simCardId) {
      calls.disabled.push(simCardId);
    },
    async setDataLimit(simCardId, mb) {
      calls.limits.push({ simCardId, mb });
    },
    async getUsage() {
      return usage;
    },
  };
  return { calls, provider };
}

test("runOnce disables the SIM when the channel is exhausted", async () => {
  const { calls, provider } = recorder({ mb: 0, status: "enabled" });
  const enforcer = createPolicyEnforcer({
    provider,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    channelBalancePort: balancePort(0n),
  });

  const action = await enforcer.runOnce(session({ meteredBytes: 900_000_000n }));

  assert.equal(action.kind, "disable");
  assert.deepEqual(calls.disabled, ["sim-1"]);
  assert.deepEqual(calls.limits, []);
});

test("runOnce tightens the data limit when the balance is inside the watermark", async () => {
  const { calls, provider } = recorder({ mb: 0, status: "enabled" });
  const enforcer = createPolicyEnforcer({
    provider,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    channelBalancePort: balancePort(BALANCE_100_USD),
  });

  // 6_000 MB → 75 USD spent → 25 USD remaining… above watermark. Use 7_000 MB:
  // 87.5 USD spent → 12.5 USD remaining → tighten to 1000 MB.
  const action = await enforcer.runOnce(session({ meteredBytes: 7_000_000_000n }));

  assert.equal(action.kind, "set_data_limit");
  assert.deepEqual(calls.limits, [{ simCardId: "sim-1", mb: 1000 }]);
  assert.deepEqual(calls.disabled, []);
});

test("runOnce does not touch the SIM while the balance is healthy", async () => {
  const { calls, provider } = recorder({ mb: 0, status: "enabled" });
  const enforcer = createPolicyEnforcer({
    provider,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    channelBalancePort: balancePort(BALANCE_100_USD),
  });

  const action = await enforcer.runOnce(session({ meteredBytes: 100_000_000n }));

  assert.equal(action.kind, "noop");
  assert.deepEqual(calls.disabled, []);
  assert.deepEqual(calls.limits, []);
});

test("creating the enforcer without a price fails unless one is provided", () => {
  const { provider } = recorder({ mb: 0, status: "enabled" });
  assert.throws(() => createPolicyEnforcer({ provider }, {}), /TELNYX_PRICE_PER_MB_USDC/);
  assert.throws(
    () => createPolicyEnforcer({ provider }, { TELNYX_PRICE_PER_MB_USDC: "-5" }),
    /TELNYX_PRICE_PER_MB_USDC/,
  );
  assert.doesNotThrow(() =>
    createPolicyEnforcer({ provider, pricePerMbRaw: PRICE_PER_MB_RAW }, {}),
  );
});