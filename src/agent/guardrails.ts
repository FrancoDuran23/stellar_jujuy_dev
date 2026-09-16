// Amount guardrails (design 4.2, 4.5; spec 3.3 AC-R2/AC-R3/AC-R7; T5.2). The
// gateway is the price authority (AC-R1) — these guardrails never invent a
// price, they only recompute the same pure function (`shared/money.ts`) and
// bound how far a single reading may move the channel forward.

import { computeExpectedAmountRaw } from "../shared/money.ts";

export type GuardrailCheckInput = {
  /** Cumulative bytes reported by this reading, since channel open (VE-R4). */
  cumulativeBytes: bigint;
  /** `cumulativeAmount` as reported by this reading (already parsed to bigint). */
  cumulativeAmount: bigint;
  pricePerMibRaw: bigint;
  /** The highest `cumulativeAmount` already signed for this channel, or `0n`
   * if none yet. */
  previousCumulativeAmountRaw: bigint;
  maxDeltaPerRequestRaw: bigint;
};

export type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: "amount_rejected"; detail: string };

/**
 * AC-R2/AC-R3: the agent recomputes `expected = ceilDiv(cumulativeBytes *
 * PRICE_PER_MIB_RAW, 1048576n)` in BigInt and requires exact equality with
 * the reported `cumulativeAmount` — any disagreement is `amount_rejected`,
 * never silently accepted or clamped.
 *
 * AC-R7: the delta against the last amount actually signed for this channel
 * must not exceed `MAX_DELTA_PER_REQUEST_RAW` — a guardrail against a
 * single reading claiming an implausibly large jump (a bug in the meter, or
 * a bogus reading), independent of whether the recomputed price matches.
 *
 * Only ever called for a reading that is strictly greater than the
 * channel's last signed amount (the idempotent-equal and stale-lower cases
 * are handled by the caller before guardrails are even relevant — AC-R2/
 * AC-R7 are about whether a *new* voucher may be signed, not about replaying
 * an old one).
 */
export function checkGuardrails(input: GuardrailCheckInput): GuardrailResult {
  const expected = computeExpectedAmountRaw(input.cumulativeBytes, input.pricePerMibRaw);
  if (expected !== input.cumulativeAmount) {
    return {
      ok: false,
      reason: "amount_rejected",
      detail: `expected cumulativeAmount ${expected} for cumulativeBytes ${input.cumulativeBytes}, received ${input.cumulativeAmount}`,
    };
  }

  const delta = input.cumulativeAmount - input.previousCumulativeAmountRaw;
  if (delta > input.maxDeltaPerRequestRaw) {
    return {
      ok: false,
      reason: "amount_rejected",
      detail: `delta ${delta} exceeds MAX_DELTA_PER_REQUEST_RAW ${input.maxDeltaPerRequestRaw}`,
    };
  }

  return { ok: true };
}
