// Message contracts between gateway/meter and agent (design 2.3.3, 2.3.4;
// spec 3.2). Message 1 is the request body of `POST /vouchers`; message 2 is
// its response body. There is exactly one HTTP call — no callbacks, no
// queue, no second endpoint.

import { z } from "zod";

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

const reasonSchema = z.enum([
  "channel_exhausted",
  "channel_closing",
  "channel_not_found",
  "channel_not_open",
  "stale_reading",
  "amount_rejected",
  "signer_unavailable",
  "upstream_unavailable",
  "internal_error",
]);

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

/** Message 2, unsigned branch (VE-R8). `retryable` is explicit — the
 * gateway must never derive it from `reason` (FT-R1). */
export const message2UnsignedSchema = z.object({
  version: z.literal(1),
  status: z.literal("unsigned"),
  sessionId: z.string().min(1),
  channel: z.string().regex(CONTRACT_ID_RE).optional(),
  reason: reasonSchema,
  retryable: z.boolean(),
  remaining: rawAmountSchema,
  meterReadingId: z.string().min(1),
  detail: z.string(),
});

export type Message2Unsigned = z.infer<typeof message2UnsignedSchema>;

export const message2Schema = z.discriminatedUnion("status", [
  message2SignedSchema,
  message2UnsignedSchema,
]);

export type Message2 = z.infer<typeof message2Schema>;
