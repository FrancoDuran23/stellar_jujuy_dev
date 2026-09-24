// Event envelope + stdout emission + optional webhook delivery (design 4.2,
// 4.5; spec 3.8, EV-R1..EV-R6, T4.2). `emit()` alone guarantees EV-R1, EV-R2,
// EV-R3: every event is always a JSON line on stdout, in the envelope shape,
// regardless of whether a webhook is configured. `createWebhookSink()` +
// `createEventEmitter()` add the optional POST path (EV-R4) without ever
// making stdout emission depend on network I/O.

import { randomUUID } from "node:crypto";
import { withRetry } from "./retry.ts";

export const EVENT_TYPES = [
  "charge.settled",
  "channel.opened",
  "channel.topped_up",
  "usage.voucher_signed",
  "channel.exhausted",
  "channel.closed",
  "channel.close_skipped",
  "payment.failed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventEnvelope<TData = Record<string, unknown>> = {
  version: 1;
  id: string;
  type: EventType;
  occurredAt: string;
  sessionId: string | null;
  userId: string | null;
  data: TData;
};

export type EmitInput<TData = Record<string, unknown>> = {
  type: EventType;
  sessionId?: string | null;
  userId?: string | null;
  data: TData;
  id?: string;
  occurredAt?: string;
};

/**
 * Writes one JSON line to stdout with the event envelope (EV-R1, EV-R2) and
 * returns it so a caller can also forward it to the webhook queue (added in
 * a later work unit). `write` is injectable for tests.
 */
export function emit<TData = Record<string, unknown>>(
  input: EmitInput<TData>,
  write: (line: string) => void = (line) => process.stdout.write(line),
): EventEnvelope<TData> {
  const envelope: EventEnvelope<TData> = {
    version: 1,
    id: input.id ?? randomUUID(),
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    sessionId: input.sessionId ?? null,
    userId: input.userId ?? null,
    data: input.data,
  };
  write(`${JSON.stringify(envelope)}\n`);
  return envelope;
}

export type WebhookSink = {
  /** Fire-and-forget: always returns immediately (EV-R5). */
  enqueue(envelope: EventEnvelope): void;
};

export type WebhookSinkOptions = {
  url: string;
  /** @default 2000 (EV-R4) */
  timeoutMs?: number;
  /** Bounds memory when the webhook endpoint is slow or down (EV-R4). @default 50 */
  maxQueueSize?: number;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so bounded retry never waits on a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once retries are exhausted. Never rethrown — EV-R5. */
  onDeliveryError?: (error: unknown, envelope: EventEnvelope) => void;
};

const DEFAULT_WEBHOOK_TIMEOUT_MS = 2000;
const DEFAULT_WEBHOOK_MAX_QUEUE_SIZE = 50;

/**
 * Builds the optional webhook delivery path (EV-R4, EV-R5, EV-R6):
 * fire-and-forget POST, 2s timeout, bounded retry (reuses `shared/retry.ts`
 * — up to 3 retries, same as any other outgoing call, FT-R3), and a bounded
 * queue so a stuck or slow endpoint can never grow memory without limit or
 * block whoever called `enqueue()`. Delivery is at-most-once (EV-R6): once
 * retries are exhausted the event is dropped, never re-queued — the voucher
 * log (not this stream) is the source of truth.
 */
export function createWebhookSink(options: WebhookSinkOptions): WebhookSink {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_WEBHOOK_MAX_QUEUE_SIZE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const queue: EventEnvelope[] = [];
  let draining = false;

  async function deliverOnce(envelope: EventEnvelope): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`webhook responded with HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const envelope = queue.shift()!;
        try {
          await withRetry(() => deliverOnce(envelope), {
            ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
          });
        } catch (error) {
          // EV-R5: a webhook failure is logged/discarded, never thrown —
          // it must never affect payment flow or any other event.
          options.onDeliveryError?.(error, envelope);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(envelope) {
      if (queue.length >= maxQueueSize) {
        return;
      }
      queue.push(envelope);
      void drain();
    },
  };
}

/**
 * Wraps `emit()` so every event is still always written to stdout (EV-R1)
 * and, when `webhookSink` is provided, also enqueued for delivery (EV-R4).
 * `config/boot.ts` builds this with a real `createWebhookSink` only when
 * `BACKEND_EVENTS_URL` is set; otherwise it behaves exactly like `emit()`.
 */
export function createEventEmitter(
  webhookSink?: WebhookSink,
): <TData = Record<string, unknown>>(
  input: EmitInput<TData>,
  write?: (line: string) => void,
) => EventEnvelope<TData> {
  return (input, write) => {
    const envelope = emit(input, write);
    webhookSink?.enqueue(envelope as EventEnvelope);
    return envelope;
  };
}
