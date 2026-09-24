// Message contracts between gateway/meter and agent (design 2.3.3, 2.3.4;
// spec 3.2). Message 1 is the request body of `POST /vouchers`; message 2 is
// its response body. There is exactly one HTTP call — no callbacks, no
// queue, no second endpoint.

import { z } from "zod";
import { isReason, retryableFor, statusFor, type Reason } from "./reasons.ts";
import { isStellarContractId } from "./stellar/keys.ts";
import { NETWORKS } from "./stellar/network.ts";

// Raw i128 units of a SEP-41 asset, 7 decimals implied. Never a JSON number
// (exceeds Number.MAX_SAFE_INTEGER for real sessions), never a decimal
// string like "0.0125" (VE-R3), and never a leading-zero string like "007"
// (review finding, Lote C: "007" is not a canonical integer literal and
// must not silently round-trip as 7).
const RAW_AMOUNT_RE = /^(0|[1-9]\d*)$/;

// i128 max: 2**127 - 1. An amount above this can never be a real SEP-41 raw
// balance and must be rejected before it reaches BigInt arithmetic anywhere
// downstream (review finding, Lote C).
const MAX_I128 = 2n ** 127n - 1n;

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const HEX_128_RE = /^[0-9a-fA-F]{128}$/;

const rawAmountSchema = z
  .string()
  .regex(RAW_AMOUNT_RE, "must be a string of digits (raw i128 units), never a decimal, a number, or a leading zero")
  // Re-checks the format before calling BigInt(): zod runs every check
  // attached to a schema even after an earlier one fails (same pitfall as
  // config/env.ts's rawPositiveIntegerRaw), so without the regex guard here
  // a value that already failed `.regex()` above (e.g. "0.0125") would still
  // reach `BigInt()` and throw a raw SyntaxError instead of a clean
  // validation issue.
  .refine(
    (value) => RAW_AMOUNT_RE.test(value) && BigInt(value) <= MAX_I128,
    "must not exceed the i128 maximum (2**127 - 1)",
  );

/**
 * Message 1 — gateway/meter -> agent, `POST /vouchers` request body.
 * `channel` is omitted in stage 1 (charge mode) and required in stage 2
 * (VE-R5); that distinction is enforced by the route handler, not here, so
 * the same schema serves both stages (design 4.1). `.strict()` (review
 * finding, Lote C, VE-R2 "schema estricto"): an unknown key must be a `400`,
 * never silently ignored.
 */
export const message1Schema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    channel: z.string().refine(isStellarContractId, "must be a 56-char Soroban contract id starting with C").optional(),
    network: z.enum(NETWORKS),
    asset: z.literal("USDC"),
    cumulativeBytes: z.number().int().nonnegative(),
    cumulativeAmount: rawAmountSchema,
    meterReadingId: z.string().min(1),
    // `offset: true` (review finding, Lote C): the meter may report in its
    // own local offset instead of normalizing to UTC first; VE-R2 asks for
    // a valid ISO datetime, not specifically a UTC one.
    observedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type Message1 = z.infer<typeof message1Schema>;

// Derived from `REASONS` (reasons.ts) instead of its own literal list, so the
// two tables can never drift apart (review finding, Lote B).
const reasonSchema = z.custom<Reason>(isReason, { message: "must be a reason known to REASONS" });

/** Message 2, signed branch (VE-R7). */
export const message2SignedSchema = z.object({
  version: z.literal(1),
  status: z.literal("signed"),
  sessionId: z.string().min(1),
  channel: z.string().refine(isStellarContractId, "must be a 56-char Soroban contract id starting with C"),
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
    channel: z.string().refine(isStellarContractId, "must be a 56-char Soroban contract id starting with C").optional(),
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
