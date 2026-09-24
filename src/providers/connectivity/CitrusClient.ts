// Citrus Client (docs/citrus-mobile-spec.md v2 §7 R3): the thin HTTP seam
// against https://citrusmobile.com/api/v2/reseller. Reuses the `HttpClient`
// shape of the old provider client (axios default, injectable in tests)
// and the repo's `withRetry`/`TimeoutError` primitives.
//
// Responsibilities:
// - Auth: `Authorization: Bearer rsk_…` on every call; the key never appears
//   in logs (the client does not log anything).
// - Rate limit: TokenBucket budgeted at ≤ 80 req/min (second line of defense
//   under the documented 100/min), and 429 retries honoring `Retry-After`.
// - Error table (R3): 429 retryable honoring Retry-After; 502/503 retryable;
//   400/401/404/409 NOT retryable (domain errors); 402 INSUFFICIENT_BALANCE
//   becomes CitrusResellerBalanceError.
// - `fund` is deliberately NOT retried (R5: a blind retry could double a fund
//   that actually landed). The FundingService reconciles timeouts by
//   re-reading the wallet; every other method retries the retryable set.
//
// Field names marked with an asterisk are the ones a live smoke test (T9)
// must confirm against the real API — see Error/Detail §12 of the spec.

import axios from "axios";
import {
  RETRY_MAX_ATTEMPTS,
  withRetry,
  TimeoutError,
  type RetryOptions,
} from "../../shared/retry.ts";
import { TokenBucket, type TokenBucketOptions } from "../../shared/token-bucket.ts";
import {
  citrusErrorFromBody,
  CitrusApiError,
} from "../../shared/citrus-errors.ts";

export const CITRUS_API_BASE = "https://citrusmobile.com/api/v2/reseller";
export const CITRUS_REQUEST_TIMEOUT_MS_DEFAULT = 10_000;

/** Minimal axios-shaped HTTP seam. Both a real axios instance and a test fake
 * satisfy it. */
export type HttpClient = {
  get<T>(url: string, config?: { signal?: AbortSignal }): Promise<{ data: T }>;
  post<T>(url: string, body?: unknown, config?: { signal?: AbortSignal }): Promise<{ data: T }>;
};

function defaultHttpClient(apiKey: string, baseURL: string): HttpClient {
  return axios.create({
    baseURL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
}

export type CitrusEsimStatus = "pending" | "active" | "suspended" | "terminated";

/** `GET /esim/{iccid}` and the truncated part of `POST /esim/provision` that
 * certificates the eSIM install payload. Money stays in USD `number` HERE —
 * this is the only place raw provider floats exist; CitrusProvider converts
 * to micro-USD at this edge. */
export type CitrusEsim = {
  /** Provision `id` — not used as the identity (that is `iccid`). */
  id: string;
  iccid: string;
  /** `lpa_string` — SM-DP+ + activation code, scanned as QR. */
  lpaString: string;
  /** `qr_code` — PNG as data URL. */
  qrCode: string;
  /** `direct_install_url` — iOS 17.4+ one tap. */
  directInstallUrl: string;
  status: CitrusEsimStatus;
  /** `wallet_balance_usd` — null when the eSIM belongs to a shared group. We
   * only provision standalone eSIMs (brief §Details 6). */
  walletBalanceUsd: number | null;
  /** `total_data_charged_usd` — LIFETIME accumulation (not per trip, U2). */
  totalDataChargedUsd: number | null;
};

/** 202 of `POST /esim/{iccid}/defund`. `settles_in_minutes` * is assumed from
 * the error table/latency notes; T9 must confirm against the OpenAPI. */
export type CitrusDefundResult = {
  settlesInMinutes: number;
  estimatedReturnUsd: number;
};

export type CitrusClientOptions = {
  apiKey: string;
  baseUrl?: string;
  httpClient?: HttpClient;
  /** Injectable clock/sleep for deterministic rate-limit tests. */
  rateLimit?: TokenBucketOptions;
  requestTimeoutMs?: number;
  retry?: RetryOptions;
  /** Injectable for tests so retries never wait on a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

export class CitrusClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly bucket: TokenBucket;
  private readonly requestTimeoutMs: number;
  private readonly retryOptions: RetryOptions;

  constructor(options: CitrusClientOptions) {
    this.baseUrl = options.baseUrl ?? CITRUS_API_BASE;
    this.http = options.httpClient ?? defaultHttpClient(options.apiKey, this.baseUrl);
    this.bucket = new TokenBucket(options.rateLimit);
    this.requestTimeoutMs = options.requestTimeoutMs ?? CITRUS_REQUEST_TIMEOUT_MS_DEFAULT;
    this.retryOptions = options.retry ?? {};
  }

  /** Provisions an eSIM (R4). `end_user_reference` is the user identity the
   * provider keeps for idempotent reuse. */
  async provision(params: { endUserReference: string; label?: string }): Promise<CitrusEsim> {
    const response = await this.request(
      async (signal) =>
        this.http.post<Record<string, unknown>>(this.join("/esim/provision"), params, { signal }),
      { maxAttempts: 1 }, // provisioning is chargeable ($1.75) — never retried
    );
    return this.parseEsim(response.data as Record<string, unknown>);
  }

  /** Reads the eSIM detail: wallet + lifetime charged + status. */
  async detail(iccid: string): Promise<CitrusEsim> {
    const response = await this.request((signal) =>
      this.http.get<Record<string, unknown>>(this.join(`/esim/${iccid}`), { signal }),
    );
    return this.parseEsim(response.data as Record<string, unknown>);
  }

  /** Funds the wallet. DELIBERATELY not retried (R5): on timeout/crash the
   * caller reconciles with `detail()` instead of blindly retrying. */
  async fund(iccid: string, amountUsd: number): Promise<void> {
    await this.request(
      (signal) =>
        this.http.post<Record<string, unknown>>(this.join(`/esim/${iccid}/fund`), { amount: amountUsd }, { signal }),
      { maxAttempts: 1 },
    );
  }

  /** Suspends data (disable). Idempotent server-side. */
  async disable(iccid: string): Promise<void> {
    await this.request((signal) =>
      this.http.post<Record<string, unknown>>(this.join(`/esim/${iccid}/disable`), undefined, { signal }),
    );
  }

  /** Resumes data (enable). Idempotent server-side. */
  async enable(iccid: string): Promise<void> {
    await this.request((signal) =>
      this.http.post<Record<string, unknown>>(this.join(`/esim/${iccid}/enable`), undefined, { signal }),
    );
  }

  /** Requests the wallet refund. Returns the 202's settlement estimate. */
  async defund(iccid: string): Promise<CitrusDefundResult> {
    const response = await this.request((signal) =>
      this.http.post<Record<string, unknown>>(this.join(`/esim/${iccid}/defund`), undefined, { signal }),
    );
    const data = response.data as Record<string, unknown> | undefined;
    return {
      settlesInMinutes: asNonNegativeInt(data?.settles_in_minutes) ?? 15,
      estimatedReturnUsd: asNonNegativeFloat(data?.estimated_return_usd) ?? 0,
    };
  }

  /** Permanently deletes the eSIM. Requires an already-empty wallet (the
   * provider enforces it locally before calling). */
  async terminate(iccid: string): Promise<void> {
    await this.request((signal) =>
      this.http.post<Record<string, unknown>>(this.join(`/esim/${iccid}/terminate`), undefined, { signal }),
    );
  }

  private parseEsim(data: Record<string, unknown>): CitrusEsim {
    const iccid = typeof data.iccid === "string" ? data.iccid : "";
    if (iccid === "") {
      throw new CitrusApiError(0, "MALFORMED_RESPONSE", "la respuesta no trajo iccid", { retryable: false });
    }
    const status = parseEsimStatus(data.status);
    return {
      id: typeof data.id === "string" ? data.id : iccid,
      iccid,
      lpaString: typeof data.lpa_string === "string" ? data.lpa_string : "",
      qrCode: typeof data.qr_code === "string" ? data.qr_code : "",
      directInstallUrl: typeof data.direct_install_url === "string" ? data.direct_install_url : "",
      status,
      walletBalanceUsd: typeof data.wallet_balance_usd === "number" ? data.wallet_balance_usd : null,
      totalDataChargedUsd: typeof data.total_data_charged_usd === "number" ? data.total_data_charged_usd : null,
    };
  }

  private async request<T>(
    run: (signal: AbortSignal) => Promise<{ data: T }>,
    options: RetryOptions = {},
  ): Promise<{ data: T }> {
    await this.bucket.take();
    const attempt = async (): Promise<{ data: T }> => {
      const signal = AbortSignal.timeout(this.requestTimeoutMs);
      try {
        return await run(signal);
      } catch (error) {
        throw this.mappedError(error);
      }
    };
    return withRetry(attempt, {
      maxAttempts: RETRY_MAX_ATTEMPTS,
      ...this.retryOptions,
      ...options,
      isRetryable: (error) => error instanceof CitrusApiError && error.retryable,
      sleep: this.retryOptions.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    });
  }

  private mappedError(error: unknown): unknown {
    if (error instanceof CitrusApiError) return error;
    if (axios.isAxiosError(error)) {
      if (error.response !== undefined) {
        const { status, data, headers } = error.response;
        const retryAfter = parseRetryAfterSeconds(headers?.["retry-after"]);
        return citrusErrorFromBody(status, data, retryAfter);
      }
      // Network-level failure (DNS, connection refused, timeout aborted).
      return error.code === "ERR_CANCELED" || error.code === "ECONNABORTED"
        ? new CitrusApiError(0, "REQUEST_TIMEOUT", `${error.message}`, { retryable: true })
        : new CitrusApiError(0, "TRANSPORT_ERROR", `${error.message}`, { retryable: true });
    }
    if (error instanceof TimeoutError) {
      return new CitrusApiError(0, "REQUEST_TIMEOUT", error.message, { retryable: true });
    }
    return error;
  }

  private join(pathname: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${pathname}`;
  }
}

function parseEsimStatus(value: unknown): CitrusEsimStatus {
  if (value === "pending" || value === "active" || value === "suspended" || value === "terminated") {
    return value;
  }
  return "pending";
}

function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
  }
  return undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function asNonNegativeFloat(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}