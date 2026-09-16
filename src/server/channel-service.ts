// Stage-2 channel verification + close orchestration (design 4.1, 4.2;
// spec CL-R4, CL-R6, CL-R8, CL-R9, CL-R10, CL-R11; WU7 T6.4/T7.3). The
// Stellar SDK is never touched here — only through ports (design 4.1's
// testability rule), all built for real in `config/boot.ts`.
//
// `closeChannel` is the ONLY function in the codebase that calls `close()`
// (task requirement) — the dispute monitor (`close-monitor.ts`) and the
// operator CLI (`server/channel-admin.ts`) both call this same function,
// never the close port directly.

import { emit as defaultEmit, type EmitInput } from "../shared/events.ts";
import type { TrustlinePort } from "../shared/stellar/trustline.ts";
import type { ChannelVoucherStore } from "./channel-store.ts";

/** Verifies an ed25519 commitment signature via the exact recipe
 * `@stellar/mpp`'s server verifies with internally (spike Part A): simulate
 * `prepare_commitment(amount)` (free, read-only) and verify the signature
 * locally against `COMMITMENT_PUBKEY`. Never throws for an invalid
 * signature (that is a typed `false`) — only for a technical/RPC failure. */
export type ChannelVerifyPort = {
  verifyCommitment(params: { channel: string; amountRaw: bigint; signatureHex: string }): Promise<boolean>;
};

export type ChannelChainInfo =
  | {
      found: true;
      depositRaw: bigint;
      balanceRaw: bigint;
      closeEffectiveAtLedger: number | null;
      currentLedger: number;
    }
  | { found: false };

export type ChannelStatePort = {
  getChannelInfo(channel: string): Promise<ChannelChainInfo>;
};

/** The one channel-close operation in the codebase (task requirement:
 * `closeChannel` is the ONLY caller of `close()`). Real implementation
 * wraps `@stellar/mpp/channel/server`'s standalone `close()` export. */
export type ChannelClosePort = {
  close(params: { channel: string; amountRaw: bigint; signatureHex: string }): Promise<{ txHash: string }>;
};

export type UsdcBalancePort = {
  getUsdcBalanceRaw(accountId: string): Promise<bigint>;
};

export type VoucherAcceptInput = {
  channel: string;
  network: string;
  cumulativeAmountRaw: bigint;
  signatureHex: string;
  commitmentPubkey: string;
  sessionId: string;
  cumulativeBytes: number;
  meterReadingId: string;
};

/** Machine-readable reasons for a rejected voucher — deliberately a
 * superset that also includes verification-only outcomes
 * (`invalid_signature`) not part of the M2 gateway vocabulary
 * (`shared/reasons.ts`); `server/routes/channel.ts` maps these to HTTP
 * status, never to a gateway-facing M2 envelope (this route is internal,
 * agent -> server only). */
export type VoucherRejectReason =
  | "channel_not_found"
  | "channel_not_open"
  | "channel_closing"
  | "channel_exhausted"
  | "invalid_signature"
  | "stale_reading";

export type VoucherAcceptOutcome =
  | { kind: "accepted"; remainingRaw: bigint }
  | { kind: "rejected"; reason: VoucherRejectReason; detail: string };

export type CloseOutcome =
  | { kind: "closed"; txHash: string; settledRaw: bigint; refundedRaw: bigint }
  | { kind: "blocked"; reason: "funder_trustline_missing"; detail: string }
  | { kind: "failed"; reason: "channel_not_found" | "refund_not_received" | "close_error"; detail: string };

export type ChannelServiceDeps = {
  store: ChannelVoucherStore;
  verifyPort: ChannelVerifyPort;
  statePort: ChannelStatePort;
  closePort: ChannelClosePort;
  trustlinePort: TrustlinePort;
  usdcBalancePort: UsdcBalancePort;
  funderAccount: string;
  emit?: (input: EmitInput) => void;
  /** @default 6 (design 4.2's CLOSE_ASSERT_ATTEMPTS default) */
  closeAssertAttempts?: number;
  /** @default 2500 (CLOSE_ASSERT_INTERVAL_MS default) */
  closeAssertIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ChannelService = {
  verifyAndAccept(input: VoucherAcceptInput): Promise<VoucherAcceptOutcome>;
  /** The only caller of `closePort.close()` (task requirement). */
  closeChannel(channel: string): Promise<CloseOutcome>;
  getHighestRaw(channel: string): bigint;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChannelService(deps: ChannelServiceDeps): ChannelService {
  const emitEvent = deps.emit ?? defaultEmit;
  const closeAssertAttempts = deps.closeAssertAttempts ?? 6;
  const closeAssertIntervalMs = deps.closeAssertIntervalMs ?? 2500;
  const sleep = deps.sleep ?? defaultSleep;

  async function verifyAndAccept(input: VoucherAcceptInput): Promise<VoucherAcceptOutcome> {
    const info = await deps.statePort.getChannelInfo(input.channel);
    if (!info.found) {
      return { kind: "rejected", reason: "channel_not_found", detail: `channel ${input.channel} not found` };
    }
    if (info.closeEffectiveAtLedger !== null) {
      return {
        kind: "rejected",
        reason: "channel_closing",
        detail: `close_start already executed (effective at ledger ${info.closeEffectiveAtLedger})`,
      };
    }
    if (input.cumulativeAmountRaw > info.depositRaw) {
      return {
        kind: "rejected",
        reason: "channel_exhausted",
        detail: `cumulative ${input.cumulativeAmountRaw} exceeds channel deposit ${info.depositRaw}`,
      };
    }

    const valid = await deps.verifyPort.verifyCommitment({
      channel: input.channel,
      amountRaw: input.cumulativeAmountRaw,
      signatureHex: input.signatureHex,
    });
    if (!valid) {
      return {
        kind: "rejected",
        reason: "invalid_signature",
        detail: "commitment signature does not verify against COMMITMENT_PUBKEY",
      };
    }

    const result = await deps.store.accept(
      {
        channel: input.channel,
        network: input.network,
        cumulativeAmountRaw: input.cumulativeAmountRaw,
        signature: input.signatureHex,
        commitmentPubkey: input.commitmentPubkey,
        sessionId: input.sessionId,
        cumulativeBytes: input.cumulativeBytes,
        meterReadingId: input.meterReadingId,
      },
      info.depositRaw,
    );
    if (!result.accepted) {
      return {
        kind: "rejected",
        reason: "stale_reading",
        detail: `cumulative ${input.cumulativeAmountRaw} is not greater than the highest accepted ${result.highestRaw}`,
      };
    }

    emitEvent({
      type: "usage.voucher_signed",
      sessionId: input.sessionId,
      data: { channel: input.channel, cumulativeAmount: input.cumulativeAmountRaw.toString(), meterReadingId: input.meterReadingId },
    });
    return { kind: "accepted", remainingRaw: result.remainingRaw };
  }

  /**
   * CL-R9, CL-R10, CL-R11. Sequence, none of it skippable:
   * 1. Pre-close trustline check (CL-R9) — cheap, and `close()`'s
   *    `try_transfer` auto-refund fails silently without it (R2).
   * 2. Read `balanceBefore` and the highest accepted voucher.
   * 3. Call `close()`.
   * 4. Poll `balanceAfter` up to `closeAssertAttempts` times,
   *    `closeAssertIntervalMs` apart (CL-R10).
   */
  async function closeChannel(channel: string): Promise<CloseOutcome> {
    const hasTrustline = await deps.trustlinePort.hasUsdcTrustline(deps.funderAccount);
    if (!hasTrustline) {
      const detail = `funder ${deps.funderAccount} does not hold a USDC trustline; close blocked to avoid a silent-failing refund (R2)`;
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "funder_trustline_missing", channel, detail } });
      return { kind: "blocked", reason: "funder_trustline_missing", detail };
    }

    const info = await deps.statePort.getChannelInfo(channel);
    if (!info.found) {
      const detail = `channel ${channel} not found at close time`;
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "channel_not_found_at_close", channel, detail } });
      return { kind: "failed", reason: "channel_not_found", detail };
    }

    const highest = deps.store.getHighest(channel);
    const highestRaw = highest?.cumulativeAmountRaw ?? 0n;
    const signatureHex = highest?.signature ?? "00".repeat(64);
    const expectedRefundRaw = info.depositRaw - highestRaw;
    const balanceBefore = await deps.usdcBalancePort.getUsdcBalanceRaw(deps.funderAccount);

    let txHash: string;
    try {
      const result = await deps.closePort.close({ channel, amountRaw: highestRaw, signatureHex });
      txHash = result.txHash;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "close_error", channel, detail } });
      return { kind: "failed", reason: "close_error", detail };
    }

    let balanceAfter = balanceBefore;
    for (let attempt = 0; attempt < closeAssertAttempts; attempt += 1) {
      await sleep(closeAssertIntervalMs);
      balanceAfter = await deps.usdcBalancePort.getUsdcBalanceRaw(deps.funderAccount);
      if (balanceAfter - balanceBefore === expectedRefundRaw) {
        emitEvent({
          type: "channel.closed",
          sessionId: null,
          data: { channel, settledRaw: highestRaw.toString(), refundedRaw: expectedRefundRaw.toString(), txHash, closedBy: "recipient" },
        });
        return { kind: "closed", txHash, settledRaw: highestRaw, refundedRaw: expectedRefundRaw };
      }
    }

    const detail = `expected funder balance to increase by ${expectedRefundRaw}, observed delta ${balanceAfter - balanceBefore} after ${closeAssertAttempts} attempts`;
    emitEvent({
      type: "payment.failed",
      sessionId: null,
      data: { reason: "refund_not_received", channel, txHash, balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString(), detail },
    });
    return { kind: "failed", reason: "refund_not_received", detail };
  }

  return {
    verifyAndAccept,
    closeChannel,
    getHighestRaw: (channel) => deps.store.getHighestRaw(channel),
  };
}
