// Bounded retry with exponential backoff and full jitter (design 4.5,
// FT-R3). Applied only to outgoing calls (Soroban RPC, the internal
// agent -> server hop) — never to a business decision. Defaults: at most 3
// retries (4 attempts total), base 250ms doubling, capped at 4s, so the
// worst case (~5.5s) stays under METER_REPORT_INTERVAL_MS (10s).

export const RETRY_MAX_ATTEMPTS = 4;
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 4000;

export type BackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

/**
 * Full jitter backoff: `delay = random(0, min(base * 2^attempt, cap))`.
 * `attempt` is 0-indexed (0 = delay before the first retry).
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  if (attempt < 0) {
    throw new RangeError("computeBackoffDelayMs: attempt must be non-negative");
  }
  const base = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const cap = options.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const upperBound = Math.min(base * 2 ** attempt, cap);
  return Math.floor(random() * upperBound);
}

export type RetryOptions = BackoffOptions & {
  maxAttempts?: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs `fn` with bounded retries. Only retries when `isRetryable(error)` is
 * true (default: always) — a schema error or an invalid signature must never
 * be retried (design 4.5). `sleep` is injectable so tests never wait on a
 * real timer.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  if (maxAttempts < 1) {
    throw new RangeError("withRetry: maxAttempts must be at least 1");
  }
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, options);
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new Error("withRetry: exhausted attempts without a result");
}
