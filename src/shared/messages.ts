// Message contracts between gateway/meter and agent (design 2.3.3, 2.3.4;
// spec 3.2). Message 1 is the request body of `POST /vouchers`; message 2 is
// its response body. There is exactly one HTTP call — no callbacks, no
// queue, no second endpoint.

import { z } from "zod";
import { isReason, retryableFor, statusFor, type Reason } from "./reasons.ts";

const NETWORKS = ["stellar:testnet", "stellar:pubnet"] as const;

// Stellar contract id: 56 chars, base32 (RFC 4648, no padding), starts with C.
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

// Raw i128 units of a SEP-41 asset, 7 decimals implied. Never a JSON number
// (exceeds Number.MAX_SAFE_INTEGER for real sessions) and never a decimal
// string like "0.0125" (VE-R3).
const RAW_AMOUNT_RE = /^\d+$/;

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const HEX_128_RE = /^[0-9a-fA-F]{128}$/;

const rawAmountSchema = z
  .string()
  .regex(RAW_AMOUNT_RE, "must be a string of digits (raw i128 units), never a decimal or a number");

/**
 * Message 1 — gateway/meter -> agent, `POST /vouchers` request body.
 * `channel` is omitted in stage 1 (charge mode) and required in stage 2
 * (VE-R5); that distinction is enforced by the route handler, not here, so
 * the same schema serves both stages (design 4.1).
 */
export const message1Schema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  channel: z.string().regex(CONTRACT_ID_RE).optional(),
  network: z.enum(NETWORKS),
  asset: z.literal("USDC"),
  cumulativeBytes: z.number().int().nonnegative(),
  cumulativeAmount: rawAmountSchema,
  meterReadingId: z.string().min(1),
  observedAt: z.iso.datetime(),
});

export type Message1 = z.infer<typeof message1Schema>;

// Derived from `REASONS` (reasons.ts) instead of its own literal list, so the
// two tables can never drift apart (review finding, Lote B).
const reasonSchema = z.custom<Reason>(isReason, { message: "must be a reason known to REASONS" });

/** Message 2, signed branch (VE-R7). */
export const message2SignedSchema = z.object({
  version: z.literal(1),
  status: z.literal("signed"),
  sessionId: z.string().min(1),
  channel: z.string().regex(CONTRACT_ID_RE),
  voucher: z.object({
    cumulativeAmount: rawAmountSchema,
    signature: z.string().regex(HEX_128_RE),
    commitmentPubkey: z.string().regex(HEX_64_RE),
    network: z.enum(NETWORKS),
  }),
  meterReadingId: z.string().min(1),
  reused: z.boolean(),
  remaining: rawAmountSchema,
  signedAt: z.iso.datetime(),
});

export type Message2Signed = z.infer<typeof message2SignedSchema>;

/**
 * Message 2, unsigned branch (VE-R8). `retryable` is explicit — the gateway
 * must never derive it from `reason` (FT-R1) — and is cross-checked against
 * the `REASONS` table by the `.refine` below, so a handler can never emit an
 * envelope where the two disagree (review finding, Lote B).
 *
 * `sessionId` and `meterReadingId` are nullable, not just optional: the
 * fail-closed middleware (`requireReady`, FC-R5) answers before any request
 * body is parsed, and the M1 validation failure path (VE-R2) may have no
 * usable body either. Both cases emit `null`, never `""` or a placeholder
 * string like `"unknown"` — `null` is unambiguous, a placeholder string is
 * not. The signed branch keeps both fields required: a signed voucher always
 * has a real session and meter reading behind it.
 */
export const message2UnsignedSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("unsigned"),
    sessionId: z.string().min(1).nullable(),
    channel: z.string().regex(CONTRACT_ID_RE).optional(),
    reason: reasonSchema,
    retryable: z.boolean(),
    remaining: rawAmountSchema,
    meterReadingId: z.string().min(1).nullable(),
    detail: z.string(),
  })
  .refine((message) => message.retryable === retryableFor(message.reason), {
    message: "retryable must match REASONS table for this reason",
    path: ["retryable"],
  });

export type Message2Unsigned = z.infer<typeof message2UnsignedSchema>;

/**
 * The only way to build an unsigned M2 envelope (review finding, Lote B):
 * `retryable` and the HTTP status are always derived from `REASONS`, never
 * written by hand at a call site. `remaining` defaults to `"0"` for contexts
 * with no channel/voucher (stage 1 direct charges, pre-body-parse
 * fail-closed responses) — VE-R7/VE-R8 only define its semantics for the
 * `POST /vouchers` response.
 */
export function buildUnsigned(
  reason: Reason,
  fields: {
    sessionId: string | null;
    channel?: string;
    remaining?: string;
    meterReadingId: string | null;
    detail: string;
  },
): { body: Message2Unsigned; status: 200 | 503 } {
  const body = message2UnsignedSchema.parse({
    version: 1,
    status: "unsigned",
    sessionId: fields.sessionId,
    ...(fields.channel !== undefined ? { channel: fields.channel } : {}),
    reason,
    retryable: retryableFor(reason),
    remaining: fields.remaining ?? "0",
    meterReadingId: fields.meterReadingId,
    detail: fields.detail,
  });
  return { body, status: statusFor(reason) };
}

export const message2Schema = z.discriminatedUnion("status", [
  message2SignedSchema,
  message2UnsignedSchema,
]);

export type Message2 = z.infer<typeof message2Schema>;
