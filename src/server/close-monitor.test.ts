// T7.2: poll getEvents-equivalent fake with injectable timers; bounded
// backoff retry of a detected dispute (review finding 3); balance-drop
// backup signal (review finding 8); monitor error never throws.

import test from "node:test";
import assert from "node:assert/strict";
import { createCloseMonitor, type CloseAttemptOutcome, type CloseWatchPort } from "./close-monitor.ts";
import type { ChannelChainInfo, ChannelStatePort } from "./channel-service.ts";
import type { EmitInput } from "../shared/events.ts";

const CHANNEL = `C${"A".repeat(55)}`;

function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  return {
    setIntervalFn: (fn: () => void, ms: number) => {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearIntervalFn: (handle: unknown) => {
      const index = scheduled.indexOf(handle as { fn: () => void; ms: number });
      if (index !== -1) scheduled.splice(index, 1);
    },
    tick() {
      for (const { fn } of [...scheduled]) fn();
    },
    get pending() {
      return scheduled.length;
    },
  };
}

function statePort(sequence: ChannelChainInfo[]): ChannelStatePort {
  let calls = 0;
  return {
    async getChannelInfo() {
      const info = sequence[Math.min(calls, sequence.length - 1)]!;
      calls += 1;
      return info;
    },
  };
}

function openInfo(overrides: Partial<Extract<ChannelChainInfo, { found: true }>> = {}): ChannelChainInfo {
  return { found: true, depositRaw: 1000n, balanceRaw: 1000n, closeEffectiveAtLedger: null, currentLedger: 1, ...overrides };
}

/** Always succeeds on the first call — the common case for tests that only
 * care about whether/how many times a close was attempted. */
function closingSucceeds(counter: { calls: number }) {
  return async (): Promise<CloseAttemptOutcome> => {
    counter.calls += 1;
    return { closed: true };
  };
}

test("triggers onClosingDetected on the very first poll if already closing", async () => {
  const timers = fakeTimers();
  const counter = { calls: 0 };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ closeEffectiveAtLedger: 500 })]),
    onClosingDetected: closingSucceeds(counter),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 1);
  assert.equal(monitor.getState().lastKnownClosing, true);
});

test("polling detects a later close_start and triggers exactly once even across multiple ticks", async () => {
  const timers = fakeTimers();
  const counter = { calls: 0 };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo(), openInfo({ closeEffectiveAtLedger: 100 }), openInfo({ closeEffectiveAtLedger: 100 })]),
    onClosingDetected: closingSucceeds(counter),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 0);

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 1);

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 1, "must not trigger a second time");
});

test("watchPort event triggers immediately, without waiting for the poll interval", async () => {
  const timers = fakeTimers();
  const counter = { calls: 0 };
  let capturedOnEvent: (() => void) | undefined;
  const watchPort: CloseWatchPort = {
    watch: (onEvent) => {
      capturedOnEvent = onEvent;
      return () => {};
    },
  };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo()]),
    watchPort,
    onClosingDetected: closingSucceeds(counter),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 0);

  capturedOnEvent?.();
  assert.equal(counter.calls, 1);
});

test("a throwing statePort never crashes the monitor — recorded as lastError", async () => {
  const timers = fakeTimers();
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: { async getChannelInfo() { throw new Error("RPC boom (spike XDR crash class)"); } },
    onClosingDetected: async () => {
      throw new Error("should never be called");
    },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  assert.doesNotThrow(() => monitor.start());
  await new Promise((r) => setImmediate(r));
  assert.match(monitor.getState().lastError ?? "", /RPC boom/);
});

test("a watchPort onError callback never crashes the monitor and the fallback poll keeps working", async () => {
  const timers = fakeTimers();
  const counter = { calls: 0 };
  const watchPort: CloseWatchPort = {
    watch: (_onEvent, onError) => {
      onError(new Error("unknown SorobanCredentialsType member for value 2"));
      return () => {};
    },
  };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ closeEffectiveAtLedger: 1 })]),
    watchPort,
    onClosingDetected: closingSucceeds(counter),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.match(monitor.getState().lastError ?? "", /SorobanCredentialsType/);
  assert.equal(counter.calls, 1, "the fallback poll still detected closing despite the watch error");
});

// --- review finding 3 (Lote F): triggered latches only on a genuine close,
// and a not-yet-closed attempt is retried with bounded backoff. ---

test("a first close attempt that does not close yet is retried (bounded backoff) and eventually latches on success", async () => {
  const timers = fakeTimers();
  const sleeps: number[] = [];
  let calls = 0;
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ closeEffectiveAtLedger: 500 })]),
    onClosingDetected: async () => {
      calls += 1;
      return { closed: calls >= 2 };
    },
    closeRetry: { maxAttempts: 3, sleep: async (ms) => { sleeps.push(ms); } },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "the first attempt failed, so a second (retried) attempt must have run");
  assert.equal(sleeps.length, 1, "exactly one backoff sleep between the two attempts");

  // A later poll tick must NOT re-attempt now that it has genuinely closed.
  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "must not retry again once closed");
});

test("every attempt in the burst failing does not latch — the next poll tick tries again", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([
      openInfo({ closeEffectiveAtLedger: 500 }),
      openInfo({ closeEffectiveAtLedger: 500 }),
    ]),
    onClosingDetected: async () => {
      calls += 1;
      return { closed: false };
    },
    closeRetry: { maxAttempts: 2, sleep: async () => {} },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "both bounded-backoff attempts in the first burst ran");
  assert.match(monitor.getState().lastError ?? "", /did not close/);

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 4, "a later poll tick retries the whole burst again — a detected dispute is never abandoned");
});

// --- review finding 8 (Lote F): balance-drop backup signal replaces the
// inert balance>depositRaw invariant. ---

test("a balance drop between polls with no close of ours on record is treated as a suspected refund/dispute and drives the close path", async () => {
  const events: EmitInput[] = [];
  const timers = fakeTimers();
  const counter = { calls: 0 };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ balanceRaw: 1000n }), openInfo({ balanceRaw: 400n })]),
    onClosingDetected: closingSucceeds(counter),
    emit: (event) => events.push(event),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 0, "no drop on the very first poll — nothing to compare against yet");

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(events.some((e) => e.type === "payment.failed" && (e.data as { reason?: string }).reason === "suspected_refund_or_dispute"));
  assert.equal(counter.calls, 1, "the drop also drives an attempt at the close path, not just an alarm");
});

test("a balance drop that IS our own successful close does not re-alarm or re-trigger", async () => {
  const events: EmitInput[] = [];
  const timers = fakeTimers();
  const counter = { calls: 0 };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([
      openInfo({ closeEffectiveAtLedger: 500, balanceRaw: 1000n }),
      openInfo({ closeEffectiveAtLedger: 500, balanceRaw: 0n }),
    ]),
    onClosingDetected: closingSucceeds(counter),
    emit: (event) => events.push(event),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 1, "closing was already true on the first poll — the monitor closed it");

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 1, "must not re-trigger for the drop caused by our own close");
  assert.equal(events.some((e) => e.type === "payment.failed" && (e.data as { reason?: string }).reason === "suspected_refund_or_dispute"), false);
});

test("a balance increase (top-up) between polls never triggers the drop signal", async () => {
  const events: EmitInput[] = [];
  const timers = fakeTimers();
  const counter = { calls: 0 };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ balanceRaw: 1000n }), openInfo({ balanceRaw: 2000n })]),
    onClosingDetected: closingSucceeds(counter),
    emit: (event) => events.push(event),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(counter.calls, 0);
  assert.equal(events.length, 0);
});

test("stop() clears the interval and stops the watch", async () => {
  const timers = fakeTimers();
  let stopWatchCalls = 0;
  const watchPort: CloseWatchPort = { watch: () => () => { stopWatchCalls += 1; } };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo()]),
    watchPort,
    onClosingDetected: async () => ({ closed: false }),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.pending, 1);
  monitor.stop();
  assert.equal(timers.pending, 0);
  assert.equal(stopWatchCalls, 1);
});
