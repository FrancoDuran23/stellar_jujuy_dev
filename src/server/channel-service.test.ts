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
const RECIPIENT = "G".padEnd(56, "R");
const TOKEN = `C${"T".repeat(55)}`;

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
    to: RECIPIENT,
    token: TOKEN,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ChannelServiceDeps> = {}): ChannelServiceDeps & { events: EmitInput[] } {
  const events: EmitInput[] = [];
  const alwaysValidVerify: ChannelVerifyPort = { async verifyCommitment() { return true; } };
  const foundOpenState: ChannelStatePort = { async getChannelInfo() { return openInfo(); } };
  const fakeClose: ChannelClosePort = { async close() { return { txHash: "close-hash" }; } };
  const trustlineOk: TrustlinePort = { async hasUsdcTrustline() { return "yes"; } };
  const balancePort: UsdcBalancePort = { async getUsdcBalanceRaw() { return 0n; } };

  return {
    store: overrides.store ?? openStore(),
    verifyPort: overrides.verifyPort ?? alwaysValidVerify,
    statePort: overrides.statePort ?? foundOpenState,
    closePort: overrides.closePort ?? fakeClose,
    trustlinePort: overrides.trustlinePort ?? trustlineOk,
    usdcBalancePort: overrides.usdcBalancePort ?? balancePort,
    funderAccount: overrides.funderAccount ?? FUNDER,
    recipientAccount: overrides.recipientAccount ?? RECIPIENT,
    expectedToken: overrides.expectedToken ?? TOKEN,
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

test("verifyAndAccept: a crash-then-retry redelivery of the same voucher is accepted again as reused, and emits usage.voucher_signed only once (review finding 4, Lote F)", async () => {
  const deps = makeDeps();
  const service = createChannelService(deps);
  const voucher = voucherInput({ cumulativeAmountRaw: 1000n, signatureHex: "a".repeat(128) });

  const first = await service.verifyAndAccept(voucher);
  assert.deepEqual(first, { kind: "accepted", remainingRaw: 999_000n });

  // Simulates: the server accepted the voucher, then the process crashed
  // before the agent's own delivering signer received the 200 — the agent
  // retries the exact same internal POST /channel/vouchers body on restart.
  const retry = await service.verifyAndAccept(voucher);
  assert.deepEqual(retry, { kind: "accepted", remainingRaw: 999_000n, reused: true });

  const signedEvents = deps.events.filter((e) => e.type === "usage.voucher_signed");
  assert.equal(signedEvents.length, 1, "a reused accept must never re-emit usage.voucher_signed");
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

test("verifyAndAccept: channel_mismatch when the channel's own `to` does not match our configured recipient (review finding 2, Lote F)", async () => {
  const deps = makeDeps({ statePort: { async getChannelInfo() { return openInfo({ to: "G".padEnd(56, "X") }); } } });
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput());
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "channel_mismatch");
});

test("verifyAndAccept: channel_mismatch when the channel's own `token` does not match our configured USDC_SAC_CONTRACT (review finding 2, Lote F)", async () => {
  const deps = makeDeps({ statePort: { async getChannelInfo() { return openInfo({ token: `C${"X".repeat(55)}` }); } } });
  const service = createChannelService(deps);
  const outcome = await service.verifyAndAccept(voucherInput());
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.reason, "channel_mismatch");
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
    trustlinePort: { async hasUsdcTrustline() { return "no"; } },
    closePort: { async close() { closeCalls += 1; return { txHash: "should-not-happen" }; } },
  });
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.deepEqual(outcome, { kind: "blocked", reason: "funder_trustline_missing", detail: outcome.kind === "blocked" ? outcome.detail : "" });
  assert.equal(closeCalls, 0);
  assert.ok(deps.events.some((e) => e.type === "payment.failed" && (e.data as { reason?: string }).reason === "funder_trustline_missing"));
});

test("closeChannel: an unknown trustline status (Horizon error) proceeds with the close instead of blocking it (review finding 3)", async () => {
  const deps = makeDeps({
    trustlinePort: { async hasUsdcTrustline() { return "unknown"; } },
  });
  await deps.store.accept(
    {
      channel: CHANNEL,
      network: "stellar:testnet",
      cumulativeAmountRaw: 125_000n,
      signature: "a".repeat(128),
      commitmentPubkey: "b".repeat(64),
      sessionId: "sess_1",
      cumulativeBytes: 1_048_576,
      meterReadingId: "mr_1",
    },
    1_000_000n,
  );
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.notEqual(outcome.kind, "blocked");
});

test("closeChannel: success when the post-close funder AND recipient balance deltas both meet their thresholds", async () => {
  const deps = makeDeps();
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));

  let settled = false;
  deps.closePort = { async close() { settled = true; return { txHash: "close-hash" }; } };
  deps.usdcBalancePort = {
    async getUsdcBalanceRaw(accountId) {
      if (!settled) return 0n;
      if (accountId === FUNDER) return 875_000n; // funder receives the remainder (1_000_000 on-chain balance - 125_000 settled)
      if (accountId === RECIPIENT) return 125_000n; // recipient receives the settled amount
      return 0n;
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

test("closeChannel: an unrelated USDC deposit into the funder's account (delta > expected) still counts as closed (review finding 7: >=, not ===)", async () => {
  const deps = makeDeps();
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));

  let settled = false;
  deps.closePort = { async close() { settled = true; return { txHash: "close-hash" }; } };
  deps.usdcBalancePort = {
    async getUsdcBalanceRaw(accountId) {
      if (!settled) return 0n;
      // Funder receives the expected refund PLUS an unrelated 50 raw units
      // from somewhere else entirely — must not fail the assertion.
      if (accountId === FUNDER) return 875_050n;
      if (accountId === RECIPIENT) return 125_000n;
      return 0n;
    },
  };
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "closed");
});

test("closeChannel: refund_not_received when neither balance ever meets its threshold after all attempts", async () => {
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

test("closeChannel: a throwing usdcBalancePort for balanceBefore never rejects — still attempts the close and comes back closed_unverified", async () => {
  const deps = makeDeps({ closeAssertAttempts: 1 });
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));
  deps.usdcBalancePort = {
    async getUsdcBalanceRaw() {
      throw new Error("simulated Soroban simulation failure (getSep41BalanceRaw)");
    },
  };
  let closeCalled = false;
  deps.closePort = {
    async close() {
      closeCalled = true;
      return { txHash: "close-hash" };
    },
  };
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(closeCalled, true, "a throwing balance port must never prevent close() from being attempted");
  assert.equal(outcome.kind, "closed_unverified");
});

test("closeChannel: a throwing usdcBalancePort for every post-close read comes back closed_unverified, never rejects", async () => {
  const deps = makeDeps({ closeAssertAttempts: 2 });
  const service = createChannelService(deps);
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));
  let calls = 0;
  deps.usdcBalancePort = {
    async getUsdcBalanceRaw() {
      calls += 1;
      if (calls === 1) return 0n; // balanceBefore succeeds once
      throw new Error("Soroban RPC down for every post-close read");
    },
  };
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "closed_unverified");
});

test("closeChannel: nothing_to_close when no voucher was ever accepted — close() is never called with a placeholder signature", async () => {
  let closeCalls = 0;
  const deps = makeDeps({
    closePort: { async close() { closeCalls += 1; return { txHash: "should-not-happen" }; } },
  });
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "nothing_to_close");
  assert.equal(closeCalls, 0);
  assert.ok(deps.events.some((e) => e.type === "channel.close_skipped"));
});

test("closeChannel: channel_mismatch (never calls close()) when the channel's own to/token do not match ours (review finding 2, Lote F)", async () => {
  let closeCalls = 0;
  const deps = makeDeps({
    statePort: { async getChannelInfo() { return openInfo({ to: "G".padEnd(56, "X") }); } },
    closePort: { async close() { closeCalls += 1; return { txHash: "should-not-happen" }; } },
  });
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "channel_mismatch");
  assert.equal(closeCalls, 0);
});

test("closeChannel: a throwing statePort never rejects and is reported as upstream_unavailable", async () => {
  const deps = makeDeps({
    statePort: { async getChannelInfo() { throw new Error("Soroban RPC transport failure"); } },
  });
  const service = createChannelService(deps);
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "upstream_unavailable");
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
  await service.verifyAndAccept(voucherInput({ cumulativeAmountRaw: 125_000n }));
  balanceReads = 0;
  const outcome = await service.closeChannel(CHANNEL);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "close_error");
  // Exactly two reads (funder + recipient balanceBefore) — the assert loop never ran.
  assert.equal(balanceReads, 2);
});
