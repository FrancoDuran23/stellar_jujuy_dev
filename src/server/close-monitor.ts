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

import type { EmitInput } from "../shared/events.ts";
import { emit as defaultEmit } from "../shared/events.ts";
import type { ChannelStatePort } from "./channel-service.ts";

export type CloseWatchPort = {
  /** Starts watching; returns a stop() function. `onEvent` fires for any
   * `close`-topic event (pending dispute or already-effective close — see
   * the spike's note that the topic alone cannot tell them apart, only
   * `effectiveAtLedger` can); `onError` must never throw. */
  watch(onEvent: () => void, onError: (error: unknown) => void): () => void;
};

export type CloseMonitorDeps = {
  channel: string;
  statePort: ChannelStatePort;
  /** Optional — the monitor still works (fallback poll only) without it. */
  watchPort?: CloseWatchPort;
  /** Called at most once per monitor lifetime (dedup: a dispute is a single
   * event to react to, not a per-poll-tick one) — `server/main.ts` wires
   * this to `channelService.closeChannel(channel)`. */
  onClosingDetected: () => void;
  /** @default 30000 (design 4.4's CHANNEL_POLL_INTERVAL_MS default) */
  pollIntervalMs?: number;
  emit?: (input: EmitInput) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

export type CloseMonitorState = {
  running: boolean;
  lastKnownClosing: boolean | undefined;
  lastError: string | undefined;
  lastPolledAt: string | undefined;
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

export function createCloseMonitor(deps: CloseMonitorDeps): CloseMonitor {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const emitEvent = deps.emit ?? defaultEmit;
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let triggered = false;
  let stopWatch: (() => void) | undefined;
  let intervalHandle: unknown;
  const state: CloseMonitorState = { running: false, lastKnownClosing: undefined, lastError: undefined, lastPolledAt: undefined };

  function triggerOnce(): void {
    if (triggered) return;
    triggered = true;
    try {
      deps.onClosingDetected();
    } catch (error) {
      // The caller's own closeChannel() already reports its own failures via
      // events; this catch exists only so a bug in that wiring can never
      // crash the monitor itself (never-crash requirement).
      state.lastError = messageOf(error);
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
      if (closing) {
        triggerOnce();
        return;
      }
      // Backup invariant (design's balance <= deposited, adapted per the
      // Facts override since `withdrawn` is unavailable): balance must
      // never exceed the tracked deposit. A drop with no close on record
      // would mean a refund raced ahead of us (R3) — surfaced as an alarm,
      // not auto-recovered.
      if (info.balanceRaw > info.depositRaw) {
        emitEvent({
          type: "payment.failed",
          sessionId: null,
          data: {
            reason: "channel_invariant_violated",
            channel: deps.channel,
            detail: `balance ${info.balanceRaw} exceeds deposit ${info.depositRaw}`,
          },
        });
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
          () => triggerOnce(),
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
