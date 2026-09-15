// Bounded retry with exponential backoff and full jitter (design 4.5,
// FT-R3). Applied only to outgoing calls (Soroban RPC, the internal
// agent -> server hop) — never to a business decision. Defaults: at most 3
// retries (4 attempts total), base 250ms doubling. `RETRY_MAX_DELAY_MS` is
// set to 1000ms, the natural ceiling of that 250/500/1000 sequence at the
// last permitted retry (attempt index 2) — not an aspirational higher cap
// that the default loop can never actually reach.
//
// Sleeps between attempts are bounded by construction, but that alone does
// not bound the *total* wall-clock time of a call: each attempt's own work
// (e.g. a slow/hanging fetch) is unbounded unless the caller adds its own
// timeout (review finding, Lote C). `deadlineMs` and `attemptTimeoutMs`
// close that gap so the total elapsed time — sleeps plus attempt work —
// stays under METER_REPORT_INTERVAL_MS (10s default), per FT-R3.

export const RETRY_MAX_ATTEMPTS = 4;
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 1000;

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

/** Thrown by `withRetry` when `deadlineMs` would be exceeded by another
 * attempt or by the sleep before one — never thrown for a plain attempt
 * failure (that always rethrows the attempt's own error). */
export class RetryDeadlineExceededError extends Error {
  readonly elapsedMs: number;
  readonly deadlineMs: number;

  constructor(elapsedMs: number, deadlineMs: number) {
    super(`withRetry: deadline of ${deadlineMs}ms exceeded after ${elapsedMs}ms`);
    this.name = "RetryDeadlineExceededError";
    this.elapsedMs = elapsedMs;
    this.deadlineMs = deadlineMs;
  }
}

export type RetryOptions = BackoffOptions & {
  maxAttempts?: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Wall-clock budget, in ms, for the whole call — every attempt and every
   * sleep combined (FT-R3: total time must stay under the meter report
   * interval). Checked before every attempt, including the first, and again
   * before the sleep that would precede the next one; exceeding it throws
   * `RetryDeadlineExceededError` instead of starting work that could not
   * finish in time. `undefined` (the default) means no deadline.
   */
  deadlineMs?: number;
  /**
   * Per-attempt timeout, in ms. Without this a single hung attempt (e.g. a
   * fetch that never resolves) can alone consume the whole `deadlineMs`
   * budget, no matter how tight the retry loop's own bookkeeping is.
   * `undefined` (the default) means attempts are not individually bounded.
   */
  attemptTimeoutMs?: number;
  /** Injectable clock for deterministic deadline tests. @default Date.now */
  now?: () => number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runAttemptWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`withRetry: attempt timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const now = options.now ?? Date.now;
  const { deadlineMs, attemptTimeoutMs } = options;
  const startedAt = now();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (deadlineMs !== undefined) {
      const elapsed = now() - startedAt;
      if (elapsed >= deadlineMs) {
        throw new RetryDeadlineExceededError(elapsed, deadlineMs);
      }
    }
    try {
      return attemptTimeoutMs !== undefined
        ? await runAttemptWithTimeout(() => fn(attempt), attemptTimeoutMs)
        : await fn(attempt);
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, options);
      if (deadlineMs !== undefined) {
        const elapsed = now() - startedAt;
        if (elapsed + delayMs >= deadlineMs) {
          throw new RetryDeadlineExceededError(elapsed, deadlineMs);
        }
      }
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new Error("withRetry: exhausted attempts without a result");
}
