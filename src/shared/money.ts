// Pricing math shared by stage 1 (delta per charge) and stage 2 (cumulative
// voucher amount) — AC-R2, AC-R4, AC-R5, S1-R5. BigInt only: money is never a
// `Number` and never floating point (AC-R5).

const BYTES_PER_MIB = 1048576n;

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
