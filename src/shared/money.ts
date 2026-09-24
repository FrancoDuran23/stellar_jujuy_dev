// Pricing math shared by stage 1 (delta per charge) and stage 2 (cumulative
// voucher amount) — AC-R2, AC-R4, AC-R5, S1-R5. BigInt only: money is never a
// `Number` and never floating point (AC-R5).

const BYTES_PER_MIB = 1048576n;

const NON_NEGATIVE_INTEGER_RE = /^(0|[1-9]\d*)$/;

/**
 * Parses a query-string-style value as a non-negative integer `bigint` — no
 * sign, no decimals, no leading zeros (same digit-string rule as
 * `shared/messages.ts::rawAmountSchema` and `config/env.ts`'s
 * `rawPositiveIntegerRaw`, applied here to byte counts, which may legitimately
 * be `0`). Returns `undefined` for anything else instead of throwing — a raw
 * `BigInt(userInput)` call throws a `SyntaxError` on malformed input, which is
 * exactly how an unvalidated `?cumulativeBytes=abc` used to turn into an
 * uncaught 500 (review finding, Lote D). Callers decide how to turn
 * `undefined` into a 400.
 */
export function parseNonNegativeIntegerRaw(value: string): bigint | undefined {
  if (!NON_NEGATIVE_INTEGER_RE.test(value)) return undefined;
  return BigInt(value);
}

/**
 * Ceiling division in BigInt: the smallest integer `q` such that
 * `q * denominator >= numerator`.
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("ceilDiv: denominator must be positive");
  }
  if (numerator < 0n) {
    throw new RangeError("ceilDiv: numerator must be non-negative");
  }
  if (numerator === 0n) {
    return 0n;
  }
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The one price function used by both stage 1 (delta billing) and stage 2
 * (cumulative voucher amount) — S1-R5 forbids a second implementation.
 * Always computed from the total accumulated bytes, never by summing
 * per-request deltas (AC-R4): that is what keeps the total rounding error of
 * a full session bounded to at most 1 raw unit.
 */
export function computeExpectedAmountRaw(
  cumulativeBytes: bigint,
  pricePerMibRaw: bigint,
): bigint {
  if (pricePerMibRaw <= 0n) {
    throw new RangeError("computeExpectedAmountRaw: pricePerMibRaw must be positive");
  }
  return ceilDiv(cumulativeBytes * pricePerMibRaw, BYTES_PER_MIB);
}

/**
 * Stage 1 charge amount: the delta between the cumulative amount owed now
 * and the cumulative amount already charged (S1-R5). Never sums independent
 * per-request roundings — always the difference of two cumulative totals.
 */
export function computeChargeDeltaRaw(
  cumulativeBytesNow: bigint,
  cumulativeBytesPrevious: bigint,
  pricePerMibRaw: bigint,
): bigint {
  if (cumulativeBytesNow < cumulativeBytesPrevious) {
    throw new RangeError(
      "computeChargeDeltaRaw: cumulativeBytesNow must not be less than cumulativeBytesPrevious",
    );
  }
  const now = computeExpectedAmountRaw(cumulativeBytesNow, pricePerMibRaw);
  const previous = computeExpectedAmountRaw(cumulativeBytesPrevious, pricePerMibRaw);
  return now - previous;
}

const BYTES_PER_MB = 1_000_000n;

/**
 * Converts a price per decimal MB (the Telnyx policy's
 * `TELNYX_PRICE_PER_MB_USDC`, 1 MB = 1_000_000 bytes) into the agent's price
 * per MiB (`PRICE_PER_MIB_RAW`, 1 MiB = 1_048_576 bytes), rounding up. Both
 * sides must bill the same tariff or the agent and the policy disagree on
 * when the channel runs out.
 */
export function pricePerMibFromPerMbRaw(pricePerMbRaw: bigint): bigint {
  if (pricePerMbRaw <= 0n) {
    throw new RangeError("pricePerMibFromPerMbRaw: pricePerMbRaw must be positive");
  }
  return ceilDiv(pricePerMbRaw * BYTES_PER_MIB, BYTES_PER_MB);
}

/**
 * True when a per-MB price and a per-MiB price describe the same tariff, up
 * to the one raw unit per MiB that an integer conversion can lose (so both
 * the floor and the ceiling of the exact conversion are accepted).
 */
export function arePricesAligned(pricePerMbRaw: bigint, pricePerMibRaw: bigint): boolean {
  const diff = pricePerMibRaw * BYTES_PER_MB - pricePerMbRaw * BYTES_PER_MIB;
  return (diff < 0n ? -diff : diff) < BYTES_PER_MB;
}
