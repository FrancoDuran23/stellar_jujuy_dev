import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arePricesAligned,
  ceilDiv,
  computeChargeDeltaRaw,
  computeExpectedAmountRaw,
  parseNonNegativeIntegerRaw,
  pricePerMibFromPerMbRaw,
} from "./money.ts";

const PRICE_PER_MIB_RAW = 10_000n;
const MIB = 1048576n;

test("computeExpectedAmountRaw(0 bytes) is 0", () => {
  assert.equal(computeExpectedAmountRaw(0n, PRICE_PER_MIB_RAW), 0n);
});

test("computeExpectedAmountRaw(exactly 1 MiB) equals the price", () => {
  assert.equal(computeExpectedAmountRaw(MIB, PRICE_PER_MIB_RAW), PRICE_PER_MIB_RAW);
});

test("computeExpectedAmountRaw(1 MiB + 1 byte) rounds up by exactly 1 raw unit", () => {
  assert.equal(computeExpectedAmountRaw(MIB + 1n, PRICE_PER_MIB_RAW), PRICE_PER_MIB_RAW + 1n);
});

test("computeExpectedAmountRaw is exact in BigInt above Number.MAX_SAFE_INTEGER", () => {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  // Pick bytes large enough that the *derived amount* (not just the byte
  // count) exceeds Number.MAX_SAFE_INTEGER, as the spec scenario requires.
  const hugeBytes = (maxSafe * MIB) / PRICE_PER_MIB_RAW + MIB;
  const result = computeExpectedAmountRaw(hugeBytes, PRICE_PER_MIB_RAW);
  // Recompute the same ceiling division independently to prove there is no
  // precision loss anywhere in the pipeline.
  const expected = (hugeBytes * PRICE_PER_MIB_RAW + MIB - 1n) / MIB;
  assert.equal(result, expected);
  assert.ok(result > maxSafe, `expected ${result} > ${maxSafe}`);
});

test("computeExpectedAmountRaw is monotonic non-decreasing over an increasing sequence", () => {
  const bytesSequence = [0n, 100n, MIB, MIB + 1n, 5n * MIB, 5n * MIB + 12345n, 100n * MIB];
  let previous = -1n;
  for (const bytes of bytesSequence) {
    const amount = computeExpectedAmountRaw(bytes, PRICE_PER_MIB_RAW);
    assert.ok(amount >= previous, `expected ${amount} >= ${previous} at bytes=${bytes}`);
    previous = amount;
  }
});

test("ceilDiv edge cases", () => {
  assert.equal(ceilDiv(0n, 7n), 0n);
  assert.equal(ceilDiv(7n, 7n), 1n);
  assert.equal(ceilDiv(8n, 7n), 2n);
  assert.throws(() => ceilDiv(-1n, 7n), RangeError);
  assert.throws(() => ceilDiv(1n, 0n), RangeError);
});

test("a full session's total rounding error is 0 because amounts are always derived from the cumulative total (AC-R4)", () => {
  // Telescoping sum: charging cumulative(now) - cumulative(prev) at every
  // step and summing those deltas must equal cumulative(final) exactly, with
  // zero drift — the property AC-R4 relies on to bound the error at <= 1 raw
  // unit for the whole session.
  const readingsBytes = [0n, 12345n, MIB, MIB + 999n, 3n * MIB + 1n, 10n * MIB - 1n];
  let totalCharged = 0n;
  for (let i = 1; i < readingsBytes.length; i += 1) {
    totalCharged += computeChargeDeltaRaw(
      readingsBytes[i]!,
      readingsBytes[i - 1]!,
      PRICE_PER_MIB_RAW,
    );
  }
  const expectedFinal = computeExpectedAmountRaw(
    readingsBytes[readingsBytes.length - 1]!,
    PRICE_PER_MIB_RAW,
  );
  assert.equal(totalCharged, expectedFinal);
});

test("computeChargeDeltaRaw rejects a decreasing cumulative reading", () => {
  assert.throws(() => computeChargeDeltaRaw(100n, 200n, PRICE_PER_MIB_RAW), RangeError);
});

test("computeExpectedAmountRaw rejects a non-positive price", () => {
  assert.throws(() => computeExpectedAmountRaw(100n, 0n), RangeError);
});

// --- parseNonNegativeIntegerRaw (review finding, Lote D: ?cumulativeBytes=
// must never reach a raw BigInt() call) ---

test("parseNonNegativeIntegerRaw accepts 0 and plain digit strings", () => {
  assert.equal(parseNonNegativeIntegerRaw("0"), 0n);
  assert.equal(parseNonNegativeIntegerRaw("1048576"), 1048576n);
});

test("parseNonNegativeIntegerRaw rejects non-digit input, leading zeros, decimals, and signs", () => {
  for (const value of ["abc", "007", "1.5", "-1", "", " 1", "1 ", "0x1"]) {
    assert.equal(parseNonNegativeIntegerRaw(value), undefined, `expected undefined for ${JSON.stringify(value)}`);
  }
});

test("pricePerMibFromPerMbRaw converts exact tariffs without rounding", () => {
  assert.equal(pricePerMibFromPerMbRaw(1_000_000n), 1_048_576n);
  assert.equal(pricePerMibFromPerMbRaw(10_000_000n), 10_485_760n);
  assert.equal(pricePerMibFromPerMbRaw(125_000n), 131_072n); // Telnyx floor, 0.0125 USDC/MB
});

test("pricePerMibFromPerMbRaw rounds a non-exact tariff up", () => {
  // 1 raw/MB = 1.048576 raw/MiB -> 2
  assert.equal(pricePerMibFromPerMbRaw(1n), 2n);
});

test("pricePerMibFromPerMbRaw rejects a non-positive price", () => {
  assert.throws(() => pricePerMibFromPerMbRaw(0n), RangeError);
});

test("arePricesAligned accepts the floor and the ceiling of the exact conversion", () => {
  assert.equal(arePricesAligned(1_000_000n, 1_048_576n), true);
  assert.equal(arePricesAligned(1n, 1n), true);
  assert.equal(arePricesAligned(1n, 2n), true);
});

test("arePricesAligned rejects a per-MiB price that is really the per-MB number", () => {
  // The classic mistake: PRICE_PER_MIB_RAW set to the per-MB figure.
  assert.equal(arePricesAligned(1_000_000n, 1_000_000n), false);
  assert.equal(arePricesAligned(10_000_000n, 1_048_576n), false);
});
