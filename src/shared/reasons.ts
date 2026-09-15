// Single source of truth for the failure taxonomy (design 4.5, spec 3.7).
// `retryable` and the HTTP status both come from this table — nowhere else
// in the codebase decides either one.
//
// This is the M2 vocabulary only: alarm-only reasons that never travel in a
// gateway-facing response (`funder_trustline_missing`, `refund_not_received`,
// `refund_raced`, `voucher_log_corrupt`, `config_invalid`) are deliberately
// NOT in this table — mixing them would let an internal alarm leak into the
// contract the gateway team froze on Wednesday.

export const REASONS = {
  channel_exhausted: { retryable: false, status: 200 },
  channel_closing: { retryable: false, status: 200 },
  channel_not_found: { retryable: false, status: 200 },
  channel_not_open: { retryable: false, status: 200 },
  stale_reading: { retryable: false, status: 200 },
  amount_rejected: { retryable: false, status: 200 },
  signer_unavailable: { retryable: true, status: 503 },
  upstream_unavailable: { retryable: true, status: 503 },
  internal_error: { retryable: true, status: 503 },
} as const;

export type Reason = keyof typeof REASONS;

export function isReason(value: unknown): value is Reason {
  return typeof value === "string" && Object.hasOwn(REASONS, value);
}

/**
 * The one error type in the codebase (design 4.5). Any untyped exception is
 * mapped to `internal_error` by the error-handling middleware — a stack
 * trace never reaches the gateway.
 */
export class PaymentError extends Error {
  readonly reason: Reason;
  readonly detail: string;

  constructor(reason: Reason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "PaymentError";
    this.reason = reason;
    this.detail = detail;
  }
}

export function retryableFor(reason: Reason): boolean {
  return REASONS[reason].retryable;
}

export function statusFor(reason: Reason): 200 | 503 {
  return REASONS[reason].status;
}
