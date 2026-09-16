import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGuardrails } from "./guardrails.ts";

const PRICE_PER_MIB_RAW = 10_000n;
const MAX_DELTA_PER_REQUEST_RAW = 5_000_000n;

test("accepts a reading whose recomputed amount matches exactly and whose delta is within bounds", () => {
  const result = checkGuardrails({
    cumulativeBytes: 1_048_576n, // exactly 1 MiB
    cumulativeAmount: 10_000n,
    pricePerMibRaw: PRICE_PER_MIB_RAW,
    previousCumulativeAmountRaw: 0n,
    maxDeltaPerRequestRaw: MAX_DELTA_PER_REQUEST_RAW,
  });
  assert.deepEqual(result, { ok: true });
});

test("rejects with amount_rejected when the recomputed amount disagrees with the reported one (AC-R2/AC-R3)", () => {
  const result = checkGuardrails({
    cumulativeBytes: 1_048_576n,
    cumulativeAmount: 9_999n, // should have been 10_000n
    pricePerMibRaw: PRICE_PER_MIB_RAW,
    previousCumulativeAmountRaw: 0n,
    maxDeltaPerRequestRaw: MAX_DELTA_PER_REQUEST_RAW,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "amount_rejected");
  assert.match(result.detail, /expected cumulativeAmount 10000/);
});

test("rejects with amount_rejected when the delta against the last signed amount exceeds MAX_DELTA_PER_REQUEST_RAW (AC-R7)", () => {
  const previousCumulativeAmountRaw = 0n;
  const cumulativeBytes = 600_000_000n; // deliberately large jump
  const cumulativeAmount = (cumulativeBytes * PRICE_PER_MIB_RAW + 1_048_575n) / 1_048_576n; // ceilDiv, matches the real amount exactly
  const result = checkGuardrails({
    cumulativeBytes,
    cumulativeAmount,
    pricePerMibRaw: PRICE_PER_MIB_RAW,
    previousCumulativeAmountRaw,
    maxDeltaPerRequestRaw: MAX_DELTA_PER_REQUEST_RAW,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "amount_rejected");
  assert.match(result.detail, /exceeds MAX_DELTA_PER_REQUEST_RAW/);
});

test("accepts a delta exactly at MAX_DELTA_PER_REQUEST_RAW (boundary, not rejected)", () => {
  const previousCumulativeAmountRaw = 1_000_000n;
  const cumulativeAmount = previousCumulativeAmountRaw + MAX_DELTA_PER_REQUEST_RAW;
  const cumulativeBytes = (cumulativeAmount * 1_048_576n) / PRICE_PER_MIB_RAW; // exact multiple, no rounding
  const result = checkGuardrails({
    cumulativeBytes,
    cumulativeAmount,
    pricePerMibRaw: PRICE_PER_MIB_RAW,
    previousCumulativeAmountRaw,
    maxDeltaPerRequestRaw: MAX_DELTA_PER_REQUEST_RAW,
  });
  assert.deepEqual(result, { ok: true });
});
