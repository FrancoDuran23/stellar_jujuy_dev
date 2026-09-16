// T6.5/T7.5: signature/exhaustion/persistence, close with trustline check,
// balance-delta assertion pass/fail — all against fakes for the four ports
// (VerifyPort, StatePort, ClosePort, TrustlinePort, UsdcBalancePort).
// Persistence itself is real (a real VoucherLog via createChannelVoucherStore).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoucherLog } from "../persistence/voucher-log.ts";
import { createChannelVoucherStore } from "./channel-store.ts";
import {
  createChannelService,
  type ChannelChainInfo,
  type ChannelClosePort,
  type ChannelServiceDeps,
  type ChannelStatePort,
  type ChannelVerifyPort,
  type UsdcBalancePort,
  type VoucherAcceptInput,
} from "./channel-service.ts";
import type { TrustlinePort } from "../shared/stellar/trustline.ts";
import type { EmitInput } from "../shared/events.ts";

const CHANNEL = `C${"A".repeat(55)}`;
const FUNDER = "G".padEnd(56, "F");

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-service-test-"));
  const opened = VoucherLog.open(path.join(dir, "vouchers-server-testnet.jsonl"));
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") throw new Error("unreachable");
  return createChannelVoucherStore(opened.log);
}

function openInfo(overrides: Partial<Extract<ChannelChainInfo, { found: true }>> = {}): ChannelChainInfo {
  return {
    found: true,
    depositRaw: 1_000_000n,
    balanceRaw: 1_000_000n,
    closeEffectiveAtLedger: null,
    currentLedger: 1000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ChannelServiceDeps> = {}): ChannelServiceDeps & { events: EmitInput[] } {
  const events: EmitInput[] = [];
  const alwaysValidVerify: ChannelVerifyPort = { async verifyCommitment() { return true; } };
  const foundOpenState: ChannelStatePort = { async getChannelInfo() { return openInfo(); } };
  const fakeClose: ChannelClosePort = { async close() { return { txHash: "close-hash" }; } };
  const trustlineOk: TrustlinePort = { async hasUsdcTrustline() { return true; } };
  const balancePort: UsdcBalancePort = { async getUsdcBalanceRaw() { return 0n; } };

  return {
    store: overrides.store ?? openStore(),
    verifyPort: overrides.verifyPort ?? alwaysValidVerify,
    statePort: overrides.statePort ?? foundOpenState,
    closePort: overrides.closePort ?? fakeClose,
    trustlinePort: overrides.trustlinePort ?? trustlineOk,
    usdcBalancePort: overrides.usdcBalancePort ?? balancePort,
    funderAccount: overrides.funderAccount ?? FUNDER,
    emit: overrides.emit ?? ((input) => events.push(input)),
    closeAssertAttempts: overrides.closeAssertAttempts ?? 3,
    closeAssertIntervalMs: overrides.closeAssertIntervalMs ?? 0,
    sleep: overrides.sleep ?? (async () => {}),
    events,
  };
}

function voucherInput(overrides: Partial<VoucherAcceptInput> = {}): VoucherAcceptInput {
  return {
    channel: CHANNEL,
    network: "stellar:testnet",
    cumulativeAmountRaw: 1000n,
    signatureHex: "a".repeat(128),
    commitmentPubkey: "b".repeat(64),
    sessionId: "sess_1",
    cumulativeBytes: 1_048_576,
    meterReadingId: "mr_1",
    ...overrides,
  };
}

test("verifyAndAccept: accepts a valid, advancing, in-budget commitment and persists it", async () => {
  const deps = makeDeps();
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput());
  assert.deepEqual(outcome, { kind: "accepted", remainingRaw: 999_000n });
  assert.equal(service.getHighestRaw(CHANNEL), 1000n);
});

test("verifyAndAccept: rejects an invalid signature without touching the store", async () => {
  const deps = makeDeps({ verifyPort: { async verifyCommitment() { return false; } } });
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput());
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "invalid_signature");
  assert.equal(service.getHighestRaw(CHANNEL), 0n);
});

test("verifyAndAccept: channel_exhausted when the amount exceeds the on-chain deposit", async () => {
  const deps = makeDeps({ statePort: { async getChannelInfo() { return openInfo({ depositRaw: 500n }); } } });
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 1000n }));
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "channel_exhausted");
});

test("verifyAndAccept: channel_closing once close_start has been detected", async () => {
  const deps = makeDeps({
    statePort: { async getChannelInfo() { return openInfo({ closeEffectiveAtLedger: 5000 }); } },
  });
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput());
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "channel_closing");
});

test("verifyAndAccept: channel_not_found when the state port reports found:false", async () => {
  const deps = makeDeps({ statePort: { async getChannelInfo() { return { found: false }; } } });
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput());
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "channel_not_found");
});

test("verifyAndAccept: a replayed/lower amount is stale_reading, not re-verified as if new", async () => {
  const deps = makeDeps();
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 2000n }));
  const outcome = await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 1000n }));
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "stale_reading");
});

test("closeChannel: blocked (never calls close()) when the funder has no USDC trustline", async () => {
  let closeCalls = 0;
  const deps = makeDeps({
    trustlinePort: { async hasUsdcTrustline() { return false; } },
    closePort: { async close() { closeCalls += 1; return { txHash: "should-not-happen" }; } },
  });
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.deepEqual(outcome, { kind: "blocked", reason: "funder_trustline_missing", detail: outcome.kind === "blocked" ? outcome.detail : "" });
  assert.equal(closeCalls, 0);
  assert.ok(deps.events.some((e) => e.type === "payment.failed" && (e.data as { reason?: string }).reason === "funder_trustline_missing"));
});

test("closeChannel: success when the post-close balance delta matches the expected refund", async () => {
  const deps = makeDeps();
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));

  let balance = 0n;
  deps.usdcBalancePort = {
    async getUsdcBalanceRaw() {
      const value = balance;
      balance = 875_000n; // funder receives the remainder (1_000_000 deposit - 125_000 settled)
      return value;
    },
  };
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "closed");
  if (outcome.kind !== "closed") return;
  assert.equal(outcome.txHash, "close-hash");
  assert.equal(outcome.settledRaw, 125_000n);
  assert.equal(outcome.refundedRaw, 875_000n);
  assert.ok(deps.events.some((e) => e.type === "channel.closed"));
});

test("closeChannel: refund_not_received when the balance never matches after all attempts", async () => {
  const deps = makeDeps({ closeAssertAttempts: 2 });
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));
  deps.usdcBalancePort = { async getUsdcBalanceRaw() { return 0n; } }; // never increases
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "refund_not_received");
  assert.ok(deps.events.some((e) => e.type === "payment.failed" && (e.data as { reason?: string }).reason === "refund_not_received"));
});

test("closeChannel: a throwing closePort maps to close_error and never touches the balance-assert loop", async () => {
  let balanceReads = 0;
  const deps = makeDeps({
    closePort: { async close() { throw new Error("simulated broadcast failure"); } },
    usdcBalancePort: {
      async getUsdcBalanceRaw() {
        balanceReads += 1;
        return 0n;
      },
    },
  });
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "close_error");
  // Exactly one read (balanceBefore) — the assert loop never ran.
  assert.equal(balanceReads, 1);
});
