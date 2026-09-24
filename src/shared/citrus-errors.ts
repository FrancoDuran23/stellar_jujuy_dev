// Citrus reseller API error taxonomy (docs/citrus-mobile-brief.md §Errors —
// codes confirmed against the OpenAPI; see docs/citrus-mobile-spec.md §7 R3:
// 429 retryable honoring Retry-After, 502/503 retryable, 400/401/404/409 NOT
// retryable, 402 INSUFFICIENT_BALANCE an operational alert, fund timeout gets
// reconciled, never blindly retried).

export class CitrusApiError extends Error {
  /** Citrus error code from the body, e.g. "ESIM_NOT_FOUND". */
  readonly code: string | undefined;
  readonly httpStatus: number;
  /** True only for the statuses the retry policy may re-attempt. */
  readonly retryable: boolean;
  /** `Retry-After` seconds when the API sent one (429). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    httpStatus: number,
    code: string | undefined,
    detail: string,
    options: { retryable: boolean; retryAfterSeconds?: number } = { retryable: false },
  ) {
    const suffix = code !== undefined ? `: ${code}` : "";
    super(`Citrus API ${httpStatus}${suffix} — ${detail}`);
    this.name = "CitrusApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** 402 INSUFFICIENT_BALANCE — reseller account out of funds. An OPERATIONAL
 * alert, never a user error: the merchant must reload the reseller balance
 * before provisioning/funding can resume. */
export class CitrusResellerBalanceError extends CitrusApiError {
  constructor(detail: string) {
    super(402, "INSUFFICIENT_BALANCE", detail, { retryable: false });
    this.name = "CitrusResellerBalanceError";
  }
}

/** 429 RATE_LIMITED — honor `Retry-After` and retry (the token bucket keeps
 * us under 100 req/min, but the API can still throttle a burst). */
export class CitrusRateLimitedError extends CitrusApiError {
  readonly retryAfterSeconds: number;

  constructor(detail: string, retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", detail, { retryable: true, retryAfterSeconds });
    this.name = "CitrusRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Local (client-side) rejection: terminate requires an empty wallet — the
 * refund must be defunded first or the reconciled return is silently lost
 * (spec §7 R9 step 5). */
export class CitrusTerminateWithBalanceError extends Error {
  readonly iccid: string;
  readonly walletMicroUsd: bigint;

  constructor(iccid: string, walletMicroUsd: bigint) {
    super(
      `no se puede terminar la eSIM ${iccid}: la wallet aún tiene ${walletMicroUsd} micro-USD — defund primero`,
    );
    this.name = "CitrusTerminateWithBalanceError";
    this.iccid = iccid;
    this.walletMicroUsd = walletMicroUsd;
  }
}

/** Maps a raw Citrus error object (any shape the API returns) to the classes
 * above. `undefined` code falls back to a plain CitrusApiError. */
export function citrusErrorFromBody(
  httpStatus: number,
  body: unknown,
  retryAfterSeconds?: number,
): CitrusApiError {
  const code = bodyCode(body);
  const detail = bodyDetail(body) ?? defaultDetail(code) ?? `HTTP ${httpStatus}`;

  if (httpStatus === 402 && code === "INSUFFICIENT_BALANCE") {
    return new CitrusResellerBalanceError(detail);
  }
  if (httpStatus === 429) {
    return new CitrusRateLimitedError(detail, retryAfterSeconds ?? 1);
  }

  const retryable = httpStatus === 502 || httpStatus === 503;
  return new CitrusApiError(httpStatus, code, detail, { retryable });
}

function bodyCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.code === "string") return record.code;
  }
  return undefined;
}

function bodyDetail(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.detail === "string") return record.detail;
  }
  return undefined;
}

function defaultDetail(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return `error del proveedor ${code}`;
}