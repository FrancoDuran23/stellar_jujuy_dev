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

// Test pricing (raw units, 1e-7 USDC): 0.0025 USD/MB — the Brazil tariff now at
// the center of the Citrus test suite (spec §6.2). 1 USD = 10_000_000 raw.
const PRICE_PER_MB_RAW = 25_000n;

// A deterministic channel: 100 USD deposit.
const BALANCE_100_USD = 1_000_000_000n;

const input = (balanceRaw: bigint, costRaw: bigint) =>
  ({ balanceRaw, costRaw, pricePerMbRaw: PRICE_PER_MB_RAW }) as const;

function session(override?: Partial<ConnectivitySession>): ConnectivitySession {
  return {
    id: "s1",
    userId: "u1",
    provider: "citrus",
    iccid: "iccid-1",
    channelId: "ch1",
    chargedMicroUsd: 0n,
    chargedBaselineMicroUsd: 0n,
    fundedMicroUsd: 0n,
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

// --- decidePolicy: the two lanes (R8: keep serving or suspend) ---

test("decidePolicy is noop while the remaining balance still pays >= 1 MB", () => {
  // 500 MB → 12.5 USD spent → 87.5 USD remaining.
  const cost = computeCostRaw(500_000_000n, PRICE_PER_MB_RAW);
  const action = decidePolicy(input(BALANCE_100_USD, cost));

  assert.equal(action.kind, "noop");
  assert.equal(action.remainingRaw, 987_500_000n);
});

test("decidePolicy suspends when the balance cannot cover the accrued cost", () => {
  const cost = computeCostRaw(1_000_000_000_000n, PRICE_PER_MB_RAW); // 25_000 USD >> deposit
  const action = decidePolicy(input(BALANCE_100_USD, cost));

  assert.equal(action.kind, "suspend");
  assert.equal(action.remainingRaw, 0n);
});

test("decidePolicy suspends when exactly zero remains", () => {
  const action = decidePolicy(input(BALANCE_100_USD, BALANCE_100_USD));
  assert.equal(action.kind, "suspend");
  assert.equal(action.remainingRaw, 0n);
});

test("decidePolicy suspends when not even 1 MB remains payable", () => {
  const action = decidePolicy(input(10_000n, 0n)); // 10_000 raw < 1 MB
  assert.equal(action.kind, "suspend");
  if (action.kind === "suspend") {
    assert.match(action.reason, /no alcanza ni para 1 MB/);
  }
});

test("decidePolicy clips a negative remaining balance to zero", () => {
  const cost = computeCostRaw(2_000_000_000_000n, PRICE_PER_MB_RAW); // >> deposit
  const action = decidePolicy(input(BALANCE_100_USD, cost));
  assert.equal(action.remainingRaw, 0n);
  assert.equal(action.kind, "suspend");
});

test("decidePolicy rejects a non-positive price", () => {
  assert.throws(() => decidePolicy({ balanceRaw: 1n, costRaw: 0n, pricePerMbRaw: 0n }), RangeError);
});

// --- runOnce end-to-end with a fake provider + real balance port ---

function recorder(usage: SimUsage) {
  const calls = { suspended: [] as string[] };
  const provider: ConnectivityProvider = {
    async provisionEsim() {
      throw new Error("not reached");
    },
    async topUp() {},
    async getUsage() {
      return usage;
    },
    async suspend(iccid) {
      calls.suspended.push(iccid);
    },
    async resume() {},
    async refundUnused() {},
    async terminate() {},
  };
  return { calls, provider };
}

// A session that has spent 1.6 USDC this trip (baseline 1.0, live 2.6) → 2_400_000_000
// equivalent accounting bytes (markup 15000, rate 10000, price 25_000/MB) = 60_000_000 raw.
function spentSession(): ConnectivitySession {
  return session({ chargedMicroUsd: 2_600_000n, chargedBaselineMicroUsd: 1_000_000n });
}

test("runOnce suspends the eSIM when the channel is exhausted", async () => {
  const { calls, provider } = recorder({ chargedMicroUsd: 2_600_000n, walletMicroUsd: 0n, status: "active", asOf: "" });
  const enforcer = createPolicyEnforcer({
    provider,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    channelBalancePort: balancePort(0n),
  });

  const action = await enforcer.runOnce(spentSession());

  assert.equal(action.kind, "suspend");
  assert.deepEqual(calls.suspended, ["iccid-1"]);
});

test("runOnce does not touch the eSIM while the balance is healthy", async () => {
  const { calls, provider } = recorder({ chargedMicroUsd: 2_600_000n, walletMicroUsd: 1_400_000n, status: "active", asOf: "" });
  const enforcer = createPolicyEnforcer({
    provider,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    channelBalancePort: balancePort(BALANCE_100_USD),
  });

  const action = await enforcer.runOnce(spentSession());

  assert.equal(action.kind, "noop");
  assert.deepEqual(calls.suspended, []);
});

test("creating the enforcer without a price fails unless one is provided", () => {
  const { provider } = recorder({ chargedMicroUsd: 0n, walletMicroUsd: 0n, status: "active", asOf: "" });
  assert.throws(() => createPolicyEnforcer({ provider }, {}), /PRICE_PER_MB_RAW/);
  assert.throws(() => createPolicyEnforcer({ provider }, { PRICE_PER_MB_RAW: "-5" }), /PRICE_PER_MB_RAW/);
  assert.doesNotThrow(() =>
    createPolicyEnforcer({ provider, pricePerMbRaw: PRICE_PER_MB_RAW }, {}),
  );
});