// Dispute / close_start monitor (design 4.2 "monitor de close_start"; spec
// CL-R6, CL-R7, CL-R8; WU7 T7.2). SDK-free — `watchPort` (real
// implementation wraps `@stellar/mpp/channel/server`'s `watchChannel()`,
// built in `config/boot.ts`) and `statePort` (shared with
// `channel-service.ts`'s `ChannelStatePort`) are both injected.
//
// Two independent detection paths, matching the task's override of CL-R6:
// 1. `watchPort.watch()` — near-real-time, via the SDK's own `getEvents`
//    cursor-tracking loop (spike Part A: "already does cursor persistence,
//    topic decoding, and typed events").
// 2. A fallback poll of `statePort.getChannelInfo()` every `pollIntervalMs`
//    — the same invariant check CL-R6 asks for
//    (`closeEffectiveAtLedger !== null` is the S2-confirmed equivalent of
//    "balance == deposited - withdrawn stops holding", since the deployed
//    wasm has no `withdrawn` getter at all — see docs/sdd/payments-mpp.md
//    §6). This path alone is enough to satisfy CL-R6/CL-R8 even if
//    `watchPort` is never wired (e.g. `checkOnChainState`-style outage).
//
// Both paths are wrapped so a crash inside either one NEVER reaches the
// caller (the spike's own finding: a long-lived Soroban RPC polling loop on
// this SDK version can throw `unknown SorobanCredentialsType member for
// value 2` from unrelated ledger activity) — `getLastError()` surfaces the
// most recent failure for `/ready` instead.
//
// Review finding 3 (Lote F): `triggered` used to latch BEFORE the close
// outcome was known (a failed/blocked close attempt still permanently
// suppressed every future one). It now latches only once `onClosingDetected`
// itself reports a genuine `{closed:true}`, and a detected-but-not-yet-closed
// dispute is retried with bounded backoff (`shared/retry.ts`) inside one
// detection event, then retried again — unbounded across events — by the
// next regular poll tick or watch event, since `triggered` stays false. This
// matches CL-R11: a detected dispute is never permanently abandoned.
//
// Review finding 8 (Lote F): the old "balance > depositRaw" backup invariant
// could never fire in practice, because `depositRaw` itself falls back to
// `state.balance` whenever the contract's own `deposited()` getter is
// unavailable (true for the only wasm revision deployable today) or no local
// deposit record exists (the demo channel #2 was opened outside the CLI) —
// so the two sides of that comparison were frequently identical by
// construction. Replaced with a DROP-detection signal: a poll-to-poll
// decrease in `balanceRaw` with no close of OUR OWN on record is treated as
// a suspected refund/dispute (R3) and also drives the close path, not just
// an alarm. KNOWN LIMITATION: this monitor instance cannot see a close
// triggered out-of-band by `server/channel-admin.ts` (a separate process
// invocation) — it would see the resulting drop and attempt its own
// (harmless but noisy) redundant close. See docs/sdd/payments-mpp.md §6,
// Lote F.

import { emit as defaultEmit, type EmitInput } from "../shared/events.ts";
import { withRetry, type RetryOptions } from "../shared/retry.ts";
import type { ChannelStatePort } from "./channel-service.ts";

export type CloseWatchPort = {
  /** Starts watching; returns a stop() function. `onEvent` fires for any
   * `close`-topic event (pending dispute or already-effective close — see
   * the spike's own note that the topic alone cannot tell them apart, only
   * `effectiveAtLedger` can); `onError` must never throw. */
  watch(onEvent: () => void, onError: (error: unknown) => void): () => void;
};

/** Result of one close attempt (review finding 3, Lote F): `closed: true`
 * only for `channelService.closeChannel`'s own `kind === "closed"` — every
 * other outcome (`closed_unverified`, `nothing_to_close`, `blocked`,
 * `failed`) is `closed: false` and therefore retryable. */
export type CloseAttemptOutcome = { closed: boolean };

export type CloseRetryOptions = Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep">;

export type CloseMonitorDeps = {
  channel: string;
  statePort: ChannelStatePort;
  /** Optional — the monitor still works (fallback poll only) without it. */
  watchPort?: CloseWatchPort;
  /**
   * Attempts one close. May be called more than once per detected dispute
   * (bounded backoff within one detection event, review finding 3) and
   * again on a later poll tick/watch event if every attempt in that burst
   * came back `{closed:false}` — a detected dispute is never abandoned
   * (CL-R11). Must never throw in practice — `server/main.ts`'s real wiring
   * already wraps `channelService.closeChannel` with its own try/catch +
   * WARN (review finding 1) — but a throw here is treated the same as
   * `{closed:false}` (retryable), never a monitor crash.
   */
  onClosingDetected: () => Promise<CloseAttemptOutcome>;
  /** @default 30000 (design 4.4's CHANNEL_POLL_INTERVAL_MS default) */
  pollIntervalMs?: number;
  emit?: (input: EmitInput) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Bounded backoff for the retries inside one detection event (review
   * finding 3). @default shared/retry.ts's own defaults, maxAttempts 4. */
  closeRetry?: CloseRetryOptions;
};

export type CloseMonitorState = {
  running: boolean;
  lastKnownClosing: boolean | undefined;
  lastError: string | undefined;
  lastPolledAt: string | undefined;
  /** Last observed on-chain balance (review finding 8's drop-detection
   * signal) — `undefined` until the first successful poll. */
  lastKnownBalanceRaw: bigint | undefined;
};

export type CloseMonitor = {
  start(): void;
  stop(): void;
  getState(): CloseMonitorState;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_CLOSE_RETRY_ATTEMPTS = 4;

export function createCloseMonitor(deps: CloseMonitorDeps): CloseMonitor {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const emitEvent = deps.emit ?? defaultEmit;
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let triggered = false;
  let attemptInFlight = false;
  let stopWatch: (() => void) | undefined;
  let intervalHandle: unknown;
  const state: CloseMonitorState = {
    running: false,
    lastKnownClosing: undefined,
    lastError: undefined,
    lastPolledAt: undefined,
    lastKnownBalanceRaw: undefined,
  };

  /**
   * Runs a bounded-backoff burst of close attempts for the CURRENT
   * detection event. Latches `triggered` only once one attempt resolves
   * `{closed:true}` — every other outcome (including every attempt in the
   * burst failing) leaves `triggered` false so the next poll tick or watch
   * event tries again (review finding 3).
   */
  async function attemptClose(): Promise<void> {
    if (triggered || attemptInFlight) return;
    attemptInFlight = true;
    try {
      await withRetry(
        async () => {
          const outcome = await deps.onClosingDetected();
          if (!outcome.closed) {
            throw new Error("close attempt did not close the channel yet");
          }
        },
        {
          maxAttempts: deps.closeRetry?.maxAttempts ?? DEFAULT_CLOSE_RETRY_ATTEMPTS,
          ...(deps.closeRetry?.baseDelayMs !== undefined ? { baseDelayMs: deps.closeRetry.baseDelayMs } : {}),
          ...(deps.closeRetry?.maxDelayMs !== undefined ? { maxDelayMs: deps.closeRetry.maxDelayMs } : {}),
          ...(deps.closeRetry?.sleep !== undefined ? { sleep: deps.closeRetry.sleep } : {}),
        },
      );
      triggered = true;
    } catch (error) {
      // The caller's own closeChannel() already reports its own failures via
      // events; this catch exists so a bug in that wiring, or every attempt
      // in this burst failing, can never crash the monitor itself
      // (never-crash requirement) — and so `triggered` is deliberately left
      // false, per the doc comment above.
      state.lastError = messageOf(error);
    } finally {
      attemptInFlight = false;
    }
  }

  async function pollOnce(): Promise<void> {
    try {
      const info = await deps.statePort.getChannelInfo(deps.channel);
      state.lastPolledAt = new Date().toISOString();
      if (!info.found) {
        state.lastError = `channel ${deps.channel} not found during close-monitor poll`;
        return;
      }
      const closing = info.closeEffectiveAtLedger !== null;
      state.lastKnownClosing = closing;

      // Drop-detection backup signal (review finding 8) — checked before the
      // primary `closing` signal so an unexpected drop is never missed even
      // if `closeEffectiveAtLedger` itself is not (yet) set (see the module
      // doc comment: `close()` alone, with no prior `close_start`, also
      // drops `balance` without ever setting `closeEffectiveAtLedger`).
      const previousBalance = state.lastKnownBalanceRaw;
      state.lastKnownBalanceRaw = info.balanceRaw;
      if (previousBalance !== undefined && info.balanceRaw < previousBalance && !triggered) {
        emitEvent({
          type: "payment.failed",
          sessionId: null,
          data: {
            reason: "suspected_refund_or_dispute",
            channel: deps.channel,
            detail: `balance dropped from ${previousBalance} to ${info.balanceRaw} with no close of ours on record`,
          },
        });
        void attemptClose();
        return;
      }

      if (closing) {
        void attemptClose();
      }
    } catch (error) {
      state.lastError = messageOf(error);
    }
  }

  function start(): void {
    if (state.running) return;
    state.running = true;

    if (deps.watchPort) {
      try {
        stopWatch = deps.watchPort.watch(
          () => void attemptClose(),
          (error) => {
            state.lastError = messageOf(error);
          },
        );
      } catch (error) {
        // watchChannel() itself throwing at setup time (not just via
        // onError) must not prevent the fallback poll from starting.
        state.lastError = messageOf(error);
      }
    }

    void pollOnce();
    intervalHandle = setIntervalFn(() => void pollOnce(), pollIntervalMs);
  }

  function stop(): void {
    if (!state.running) return;
    state.running = false;
    stopWatch?.();
    stopWatch = undefined;
    if (intervalHandle !== undefined) {
      clearIntervalFn(intervalHandle);
      intervalHandle = undefined;
    }
  }

  return { start, stop, getState: () => ({ ...state }) };
}
