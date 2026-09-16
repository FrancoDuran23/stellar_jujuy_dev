// T7.2: poll getEvents-equivalent fake with injectable timers; invariant
// balance>deposited detects refund_raced-style anomalies; monitor error
// never throws.

import test from "node:test";
import assert from "node:assert/strict";
import { createCloseMonitor, type CloseWatchPort } from "./close-monitor.ts";
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

test("triggers onClosingDetected on the very first poll if already closing", async () => {
  const timers = fakeTimers();
  let closedCalls = 0;
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ closeEffectiveAtLedger: 500 })]),
    onClosingDetected: () => {
      closedCalls += 1;
    },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(closedCalls, 1);
  assert.equal(monitor.getState().lastKnownClosing, true);
});

test("polling detects a later close_start and triggers exactly once even across multiple ticks", async () => {
  const timers = fakeTimers();
  let closedCalls = 0;
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo(), openInfo({ closeEffectiveAtLedger: 100 }), openInfo({ closeEffectiveAtLedger: 100 })]),
    onClosingDetected: () => {
      closedCalls += 1;
    },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(closedCalls, 0);

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(closedCalls, 1);

  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(closedCalls, 1, "must not trigger a second time");
});

test("watchPort event triggers immediately, without waiting for the poll interval", async () => {
  const timers = fakeTimers();
  let closedCalls = 0;
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
    onClosingDetected: () => {
      closedCalls += 1;
    },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(closedCalls, 0);

  capturedOnEvent?.();
  assert.equal(closedCalls, 1);
});

test("a throwing statePort never crashes the monitor — recorded as lastError", async () => {
  const timers = fakeTimers();
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: { async getChannelInfo() { throw new Error("RPC boom (spike XDR crash class)"); } },
    onClosingDetected: () => {
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
  let closedCalls = 0;
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
    onClosingDetected: () => {
      closedCalls += 1;
    },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.match(monitor.getState().lastError ?? "", /SorobanCredentialsType/);
  assert.equal(closedCalls, 1, "the fallback poll still detected closing despite the watch error");
});

test("emits payment.failed when balance exceeds the tracked deposit (refund raced ahead of us)", async () => {
  const events: EmitInput[] = [];
  const timers = fakeTimers();
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo({ balanceRaw: 2000n, depositRaw: 1000n })]),
    onClosingDetected: () => {},
    emit: (event) => events.push(event),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
  monitor.start();
  await new Promise((r) => setImmediate(r));
  assert.ok(events.some((e) => e.type === "payment.failed" && (e.data as { reason?: string }).reason === "channel_invariant_violated"));
});

test("stop() clears the interval and stops the watch", async () => {
  const timers = fakeTimers();
  let stopWatchCalls = 0;
  const watchPort: CloseWatchPort = { watch: () => () => { stopWatchCalls += 1; } };
  const monitor = createCloseMonitor({
    channel: CHANNEL,
    statePort: statePort([openInfo()]),
    watchPort,
    onClosingDetected: () => {},
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
