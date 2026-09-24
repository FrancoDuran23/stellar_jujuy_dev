import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventEmitter, createWebhookSink, type EventEnvelope } from "./events.ts";

function immediateSleep(): Promise<void> {
  return Promise.resolve();
}

test("createWebhookSink POSTs the envelope as JSON with a content-type header (EV-R4)", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const sink = createWebhookSink({
    url: "http://backend.example/events",
    sleep: immediateSleep,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });

  sink.enqueue({
    version: 1,
    id: "evt_1",
    type: "usage.voucher_signed",
    occurredAt: "2026-09-17T00:00:00.000Z",
    sessionId: "sess_1",
    userId: null,
    data: { cumulativeAmount: "125000" },
  });

  // enqueue() is synchronous/fire-and-forget (EV-R5) — give the microtask
  // queue a turn so the (immediately-resolving, injected) delivery settles.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://backend.example/events");
  assert.equal(calls[0]!.init.method, "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(JSON.parse(calls[0]!.init.body as string).id, "evt_1");
});

test("createWebhookSink retries up to 3 times on failure, then gives up (EV-R4, at-most-once EV-R6)", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const sink = createWebhookSink({
    url: "http://backend.example/events",
    sleep: immediateSleep,
    fetchImpl: (async () => {
      attempts += 1;
      throw new Error("connection refused");
    }) as unknown as typeof fetch,
    onDeliveryError: (error) => errors.push(error),
  });

  sink.enqueue({
    version: 1,
    id: "evt_2",
    type: "channel.exhausted",
    occurredAt: "2026-09-17T00:00:00.000Z",
    sessionId: null,
    userId: null,
    data: {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 4, "1 initial attempt + up to 3 retries");
  assert.equal(errors.length, 1);
});

test("createWebhookSink treats a non-ok HTTP response as a failure worth retrying", async () => {
  let attempts = 0;
  const sink = createWebhookSink({
    url: "http://backend.example/events",
    sleep: immediateSleep,
    fetchImpl: (async () => {
      attempts += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch,
    onDeliveryError: () => {},
  });

  sink.enqueue({
    version: 1,
    id: "evt_3",
    type: "channel.closed",
    occurredAt: "2026-09-17T00:00:00.000Z",
    sessionId: null,
    userId: null,
    data: {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 4);
});

test("createWebhookSink drops events beyond maxQueueSize instead of growing without bound (EV-R4)", async () => {
  let attempts = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sink = createWebhookSink({
    url: "http://backend.example/events",
    maxQueueSize: 1,
    sleep: immediateSleep,
    fetchImpl: (async () => {
      attempts += 1;
      await gate;
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });

  const envelope = (id: string): EventEnvelope => ({
    version: 1,
    id,
    type: "usage.voucher_signed",
    occurredAt: "2026-09-17T00:00:00.000Z",
    sessionId: null,
    userId: null,
    data: {},
  });

  sink.enqueue(envelope("a")); // starts draining immediately, occupies the in-flight slot
  sink.enqueue(envelope("b")); // queued (queue length 1, at capacity)
  sink.enqueue(envelope("c")); // dropped — queue already at maxQueueSize

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2, "only the in-flight event and the one queued item are ever delivered");
});

test("createWebhookSink failures never throw out of enqueue() (EV-R5)", () => {
  const sink = createWebhookSink({
    url: "http://backend.example/events",
    sleep: immediateSleep,
    fetchImpl: (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch,
  });

  assert.doesNotThrow(() => {
    sink.enqueue({
      version: 1,
      id: "evt_4",
      type: "payment.failed",
      occurredAt: "2026-09-17T00:00:00.000Z",
      sessionId: null,
      userId: null,
      data: {},
    });
  });
});

test("createEventEmitter always writes to stdout even without a webhook sink (backward compatible with emit())", () => {
  const lines: string[] = [];
  const emitEvent = createEventEmitter();
  const envelope = emitEvent(
    { type: "usage.voucher_signed", sessionId: "sess_1", data: { cumulativeAmount: "1" } },
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), envelope);
});

test("createEventEmitter forwards every emitted event to the webhook sink", () => {
  const enqueued: EventEnvelope[] = [];
  const emitEvent = createEventEmitter({ enqueue: (envelope) => enqueued.push(envelope) });
  emitEvent({ type: "channel.opened", sessionId: null, data: {} }, () => {});
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.type, "channel.opened");
});
