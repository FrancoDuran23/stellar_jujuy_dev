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
  | "stale_reading"
  | "upstream_unavailable";

export type VoucherAcceptOutcome =
  | { kind: "accepted"; remainingRaw: bigint }
  | { kind: "rejected"; reason: VoucherRejectReason; detail: string };

export type CloseOutcome =
  | { kind: "closed"; txHash: string; settledRaw: bigint; refundedRaw: bigint }
  /** `close()` broadcast successfully but the funder/recipient balance
   * deltas could not be verified (every pre- or post-close balance read
   * failed) — review finding 1, Lote F. Distinct from `refund_not_received`
   * (where reads succeeded but never matched): here we simply don't know,
   * so we never claim success OR failure of the settlement itself. */
  | { kind: "closed_unverified"; txHash: string; settledRaw: bigint }
  /** No voucher was ever accepted for this channel — review finding 10a,
   * Lote F. `close()` is never called with a zero/placeholder signature. */
  | { kind: "nothing_to_close"; detail: string }
  | { kind: "blocked"; reason: "funder_trustline_missing"; detail: string }
  | {
      kind: "failed";
      reason: "channel_not_found" | "refund_not_received" | "close_error" | "upstream_unavailable";
      detail: string;
    };

export type ChannelServiceDeps = {
  store: ChannelVoucherStore;
  verifyPort: ChannelVerifyPort;
  statePort: ChannelStatePort;
  closePort: ChannelClosePort;
  trustlinePort: TrustlinePort;
  usdcBalancePort: UsdcBalancePort;
  funderAccount: string;
  /** Server's own `STELLAR_RECIPIENT` — review finding 7, Lote F: the
   * close-verification loop now also confirms the recipient actually
   * received at least the settled amount, not just that the funder's
   * refund arrived. */
  recipientAccount: string;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createChannelService(deps: ChannelServiceDeps): ChannelService {
  const emitEvent = deps.emit ?? defaultEmit;
  const closeAssertAttempts = deps.closeAssertAttempts ?? 6;
  const closeAssertIntervalMs = deps.closeAssertIntervalMs ?? 2500;
  const sleep = deps.sleep ?? defaultSleep;

  async function verifyAndAccept(input: VoucherAcceptInput): Promise<VoucherAcceptOutcome> {
    let info: ChannelChainInfo;
    try {
      info = await deps.statePort.getChannelInfo(input.channel);
    } catch (error) {
      // A statePort that throws (review finding 5, Lote F: a genuine
      // transport failure, not a routine "not found") must never crash this
      // route — reported as a retryable rejection instead.
      return {
        kind: "rejected",
        reason: "upstream_unavailable",
        detail: `channel state lookup failed: ${messageOf(error)}`,
      };
    }
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

  /** Never throws — a balance read failure is a data point ("unknown"), not
   * a reason to abort or crash the close flow (review finding 1, Lote F:
   * `getSep41BalanceRaw` throws on a failed simulation, and this used to sit
   * outside every try/catch in `closeChannel`). */
  async function readUsdcBalanceSafe(accountId: string): Promise<bigint | undefined> {
    try {
      return await deps.usdcBalancePort.getUsdcBalanceRaw(accountId);
    } catch {
      return undefined;
    }
  }

  /**
   * CL-R9, CL-R10, CL-R11. Sequence, none of it skippable:
   * 1. Pre-close trustline check (CL-R9) — cheap, and `close()`'s
   *    `try_transfer` auto-refund fails silently without it (R2). Tri-state
   *    (review finding 3, Lote F): "unknown" (Horizon down) fails OPEN —
   *    blocking a close over a diagnosis failure is worse than proceeding.
   * 2. Read `balanceBefore` for the funder AND the recipient, and the
   *    highest accepted voucher (review finding 10a: no voucher at all means
   *    there is nothing to settle — `close()` is never called with a
   *    zero/placeholder signature).
   * 3. Call `close()`.
   * 4. Poll both balances up to `closeAssertAttempts` times,
   *    `closeAssertIntervalMs` apart (CL-R10), asserting each delta is AT
   *    LEAST the expected amount (review finding 7, Lote F: `>=`, not `===`
   *    — an unrelated USDC movement into either account must never fail
   *    this assertion; the funder's expected refund is computed from the
   *    on-chain `balanceRaw`, not the server's own tracked `depositRaw`,
   *    since `balanceRaw` is what `close()` actually refunds).
   *
   * Never rejects — every failure mode (including a throwing balance port)
   * resolves to a typed `CloseOutcome` so a fire-and-forget caller
   * (`config/boot.ts`'s close-monitor wiring) can never produce an
   * unhandled rejection (review finding 1, Lote F).
   */
  async function closeChannel(channel: string): Promise<CloseOutcome> {
    const trustline = await deps.trustlinePort.hasUsdcTrustline(deps.funderAccount);
    if (trustline === "no") {
      const detail = `funder ${deps.funderAccount} does not hold a USDC trustline; close blocked to avoid a silent-failing refund (R2)`;
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "funder_trustline_missing", channel, detail } });
      return { kind: "blocked", reason: "funder_trustline_missing", detail };
    }
    if (trustline === "unknown") {
      console.warn(
        JSON.stringify({
          level: "warn",
          reason: "funder_trustline_check_unavailable",
          channel,
          detail: "Horizon trustline lookup failed; proceeding with close anyway (fail-open, review finding 3, Lote F)",
        }),
      );
    }

    let info: ChannelChainInfo;
    try {
      info = await deps.statePort.getChannelInfo(channel);
    } catch (error) {
      const detail = `channel state lookup failed at close time: ${messageOf(error)}`;
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "upstream_unavailable", channel, detail } });
      return { kind: "failed", reason: "upstream_unavailable", detail };
    }
    if (!info.found) {
      const detail = `channel ${channel} not found at close time`;
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "channel_not_found_at_close", channel, detail } });
      return { kind: "failed", reason: "channel_not_found", detail };
    }

    const highest = deps.store.getHighest(channel);
    if (highest === undefined) {
      const detail = `channel ${channel} has no accepted vouchers; nothing to settle`;
      emitEvent({ type: "channel.close_skipped", sessionId: null, data: { channel, detail } });
      return { kind: "nothing_to_close", detail };
    }
    const highestRaw = highest.cumulativeAmountRaw;
    const signatureHex = highest.signature;
    const expectedRefundRaw = info.balanceRaw - highestRaw;

    const funderBefore = await readUsdcBalanceSafe(deps.funderAccount);
    const recipientBefore = await readUsdcBalanceSafe(deps.recipientAccount);

    let txHash: string;
    try {
      const result = await deps.closePort.close({ channel, amountRaw: highestRaw, signatureHex });
      txHash = result.txHash;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emitEvent({ type: "payment.failed", sessionId: null, data: { reason: "close_error", channel, detail } });
      return { kind: "failed", reason: "close_error", detail };
    }

    if (funderBefore === undefined && recipientBefore === undefined) {
      emitEvent({
        type: "channel.closed",
        sessionId: null,
        data: { channel, settledRaw: highestRaw.toString(), txHash, closedBy: "recipient", verified: false },
      });
      return { kind: "closed_unverified", txHash, settledRaw: highestRaw };
    }

    let funderAfter = funderBefore;
    let recipientAfter = recipientBefore;
    let sawReading = false;
    for (let attempt = 0; attempt < closeAssertAttempts; attempt += 1) {
      await sleep(closeAssertIntervalMs);
      if (funderBefore !== undefined) {
        const reading = await readUsdcBalanceSafe(deps.funderAccount);
        if (reading !== undefined) {
          funderAfter = reading;
          sawReading = true;
        }
      }
      if (recipientBefore !== undefined) {
        const reading = await readUsdcBalanceSafe(deps.recipientAccount);
        if (reading !== undefined) {
          recipientAfter = reading;
          sawReading = true;
        }
      }
      const funderOk =
        funderBefore === undefined || (funderAfter !== undefined && funderAfter - funderBefore >= expectedRefundRaw);
      const recipientOk =
        recipientBefore === undefined ||
        (recipientAfter !== undefined && recipientAfter - recipientBefore >= highestRaw);
      if (funderOk && recipientOk) {
        const refundedRaw = funderAfter !== undefined && funderBefore !== undefined ? funderAfter - funderBefore : expectedRefundRaw;
        emitEvent({
          type: "channel.closed",
          sessionId: null,
          data: { channel, settledRaw: highestRaw.toString(), refundedRaw: refundedRaw.toString(), txHash, closedBy: "recipient" },
        });
        return { kind: "closed", txHash, settledRaw: highestRaw, refundedRaw };
      }
    }

    if (!sawReading) {
      emitEvent({
        type: "channel.closed",
        sessionId: null,
        data: { channel, settledRaw: highestRaw.toString(), txHash, closedBy: "recipient", verified: false },
      });
      return { kind: "closed_unverified", txHash, settledRaw: highestRaw };
    }

    const detail =
      `expected funder balance to increase by at least ${expectedRefundRaw} and recipient balance by at least ${highestRaw}, ` +
      `observed funder delta ${funderAfter !== undefined && funderBefore !== undefined ? funderAfter - funderBefore : "unknown"}, ` +
      `recipient delta ${recipientAfter !== undefined && recipientBefore !== undefined ? recipientAfter - recipientBefore : "unknown"} ` +
      `after ${closeAssertAttempts} attempts`;
    emitEvent({
      type: "payment.failed",
      sessionId: null,
      data: { reason: "refund_not_received", channel, txHash, detail },
    });
    return { kind: "failed", reason: "refund_not_received", detail };
  }

  return {
    verifyAndAccept,
    closeChannel,
    getHighestRaw: (channel) => deps.store.getHighestRaw(channel),
  };
}
