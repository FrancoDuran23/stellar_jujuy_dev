// Accepted-commitment store (WU7, T6.4/"AtomicStore adapter"). Persists
// every accepted voucher to the server's own JSONL log
// (`data/vouchers-server-{network}.jsonl`, opened by `config/boot.ts` via
// the same `VoucherLog` the agent already uses) — append + fsync BEFORE the
// accept resolves (design 4.2: "el server hace append y fsync antes de
// responder accepted"), and the highest-per-channel index is rebuilt at
// boot automatically by `VoucherLog.open()`'s replay, exactly like the
// agent's own log.
//
// Deviation from the letter of the WU7 brief, documented in
// docs/sdd/payments-mpp.md §6 (Lote E): this is NOT a `Store.AtomicStore`
// plugged into `@stellar/mpp/channel/server`'s `stellar.channel(...)`
// Method. That Method's `verify()` is only reachable through its own
// challenge/credential round trip mediated by an `Mppx` server instance —
// there is no way to call it directly for a voucher whose signature was
// already computed and delivered over our own internal agent -> server
// HTTP hop. `server/channel-service.ts` verifies commitments with the exact
// same recipe the SDK uses internally (simulate `prepare_commitment` +
// local ed25519 verify, `shared/stellar/channel-contract.ts`), and this
// module gives that verification a durable, atomic (per-channel mutex),
// monotonic accept — the same guarantees an `AtomicStore.update()` would
// provide, purpose-built for our own JSONL instead of a generic KV shape.

import type { VoucherIndexEntry, VoucherLog, VoucherRecord } from "../persistence/voucher-log.ts";
import { createChannelMutex, type ChannelMutex } from "../shared/mutex.ts";

export type AcceptCommitmentInput = {
  channel: string;
  network: string;
  cumulativeAmountRaw: bigint;
  signature: string;
  commitmentPubkey: string;
  sessionId: string;
  cumulativeBytes: number;
  meterReadingId: string;
};

export type AcceptCommitmentResult =
  | { accepted: true; remainingRaw: bigint }
  | { accepted: false; reason: "stale"; highestRaw: bigint };

export type ChannelVoucherStore = {
  /** The highest accepted cumulative amount for `channel`, or `0n` if none
   * yet (never `undefined` — a channel with no accepted voucher has
   * accepted "0" by definition, same convention `agent/routes/vouchers.ts`
   * uses). */
  getHighestRaw(channel: string): bigint;
  /** The full highest-accepted record (amount + signature + pubkey) —
   * `closeChannel` (`channel-service.ts`) needs the signature to build the
   * `close(amount, signature)` contract call, not just the raw amount. */
  getHighest(channel: string): VoucherIndexEntry | undefined;
  /**
   * Serializes accept() calls per channel (mutex) so two concurrent
   * requests can never both "win" against the same previous highest, then
   * appends + fsyncs before resolving. `depositRaw` is passed in per call
   * (not cached here) — the caller (`channel-service.ts`) already has a
   * fresh contract read for the exhaustion check that happens before this
   * is even called.
   */
  accept(input: AcceptCommitmentInput, depositRaw: bigint): Promise<AcceptCommitmentResult>;
};

function clampMin0(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function createChannelVoucherStore(
  voucherLog: VoucherLog,
  deps: { now?: () => Date; mutex?: ChannelMutex } = {},
): ChannelVoucherStore {
  const mutex = deps.mutex ?? createChannelMutex();
  const now = deps.now ?? (() => new Date());

  return {
    getHighestRaw(channel) {
      return voucherLog.getHighest(channel)?.cumulativeAmountRaw ?? 0n;
    },
    getHighest(channel) {
      return voucherLog.getHighest(channel);
    },
    accept(input, depositRaw) {
      return mutex.withChannelLock(input.channel, async () => {
        const previous = voucherLog.getHighest(input.channel);
        const previousRaw = previous?.cumulativeAmountRaw ?? 0n;
        if (input.cumulativeAmountRaw <= previousRaw) {
          return { accepted: false, reason: "stale", highestRaw: previousRaw };
        }
        const record: VoucherRecord = {
          v: 1,
          ts: now().toISOString(),
          network: input.network,
          channel: input.channel,
          sessionId: input.sessionId,
          cumulativeAmount: input.cumulativeAmountRaw.toString(),
          cumulativeBytes: input.cumulativeBytes,
          signature: input.signature,
          commitmentPubkey: input.commitmentPubkey,
          meterReadingId: input.meterReadingId,
        };
        // Append + fsync happen inside append() — BEFORE this resolves
        // (design 4.2's ordering rule).
        voucherLog.append(record);
        return { accepted: true, remainingRaw: clampMin0(depositRaw - input.cumulativeAmountRaw) };
      });
    },
  };
}
