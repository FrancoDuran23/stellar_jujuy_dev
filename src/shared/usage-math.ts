// Usage math for the Citrus connectivity layer (docs/citrus-mobile-spec.md v2):
// translating the provider's true consumption measurement (micro-USD charged)
// into the byte accumulation the agent charges on, and the prepaid wallet size
// a given deposit supports. Pure bigint functions — no floats, no provider
// calls (AC-R5).

/** 1e-7 USDC raw unit in micro-USD: 1 USDC = 10_000_000 raw = 1_000_000 micro. */
const MICRO_USD_PER_RAW = 10n;

/**
 * Spec v2 §6.2 — the ONLY way charged consumption becomes bytes:
 *
 *   equivalentBytes = floor( chargedSessionMicroUsd × MARKUP_BPS × 10_000_000
 *                            / (USDC_USD_RATE_BPS × PRICE_PER_MB_RAW) )
 *
 * Dimension check (spec §6.2, Brasil example): $3.60 charged (3 600 000
 * micro-USD), markup 15000 bps, USDC_USD_RATE_BPS 10000, PRICE_PER_MB_RAW
 * 25000 (raw/MB) gives exactly 2 160 000 000 bytes: 2160 MB × 25000 = 54 000 000
 * raw = 5.4 USDC = 3.60 × 1.5.
 *
 * Because of the 10_000_000 | 1_000_000 scaling, `equivalentBytes` (as MB) ×
 * `PRICE_PER_MB_RAW` equals `chargedSession × MARKUP` in USDC — so the
 * voucher's cumulative amount tracks what Citrus actually deducts, in every
 * country, with no per-country tariffs (I1). The "bytes" are an accounting
 * unit for the agent, not real bytes (spec §6.2).
 */
export function equivalentBytes(
  chargedSessionMicroUsd: bigint,
  markupBps: number,
  usdcUsdRateBps: number,
  pricePerMbRaw: bigint,
): bigint {
  if (chargedSessionMicroUsd < 0n) {
    throw new RangeError("equivalentBytes: chargedSessionMicroUsd must be non-negative");
  }
  if (markupBps < 1 || usdcUsdRateBps < 1) {
    throw new RangeError("equivalentBytes: markupBps and usdcUsdRateBps must be greater than 0");
  }
  if (pricePerMbRaw <= 0n) {
    throw new RangeError("equivalentBytes: pricePerMbRaw must be positive");
  }
  const denominator = BigInt(usdcUsdRateBps) * pricePerMbRaw;
  return (
    (chargedSessionMicroUsd * BigInt(markupBps) * 10_000_000n) / denominator
  );
}

/**
 * Spec v2 §5, invariant I2 — the wallet size a deposit supports, in integer
 * cents (Citrus `fund` amounts):
 *
 *   maxWalletCents = floor( depositRaw × USDC_USD_RATE_BPS
 *                            / (100 000 × MARKUP_BPS) )
 *
 * Check: 5 USDC deposit (50_000_000 raw), markup 15000 → 333 cents ($3.33),
 * i.e. 2_000 MB at the Brazil tariff -> the user's $3.33 purchases as much
 * raw as the raw $5.00 the merchant deposited, after the markup (D5).
 */
export function maxWalletCents(
  depositRaw: bigint,
  usdcUsdRateBps: number,
  markupBps: number,
): number {
  if (depositRaw < 0n) {
    throw new RangeError("maxWalletCents: depositRaw must be non-negative");
  }
  if (markupBps < 1 || usdcUsdRateBps < 1) {
    throw new RangeError("maxWalletCents: markupBps and usdcUsdRateBps must be greater than 0");
  }
  const cents = (depositRaw * BigInt(usdcUsdRateBps)) / (100_000n * BigInt(markupBps));
  const max = Number(cents);
  return max > 10_000 ? 10_000 : max;
}