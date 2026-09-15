// Event envelope + stdout emission (design 4.2, 4.5; spec 3.8). The webhook
// delivery path (EV-R4, EV-R5, EV-R6) is added in a later work unit
// (config/boot.ts wiring, T4.2) — this module only guarantees EV-R1, EV-R2,
// and EV-R3: every event is always a JSON line on stdout, in the envelope
// shape, and at least the required event types exist as valid values.

import { randomUUID } from "node:crypto";

export const EVENT_TYPES = [
  "charge.settled",
  "channel.opened",
  "channel.topped_up",
  "usage.voucher_signed",
  "channel.exhausted",
  "channel.closed",
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
