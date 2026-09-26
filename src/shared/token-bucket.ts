// Token bucket rate limiter for the Citrus reseller API (docs/citrus-mobile-
// brief.md: 100 req/min per key; the client budgets ≤ 80) — the second line
// of defense under the 429 retry. `take()` waits until `weight` tokens are
// available, so a burst never exceeds the refill rate for long.

export type TokenBucketOptions = {
  /** Refill rate, in requests per minute (budget floor ≤ 80). */
  tokensPerMinute?: number;
  /** Burst capacity. Defaults to `tokensPerMinute` (no burst allowance). */
  capacity?: number;
  /** Injectable clock. @default Date.now */
  now?: () => number;
  /** Injectable sleep for tests (never a real timer). @default setTimeout */
  sleep?: (ms: number) => Promise<void>;
};

export class TokenBucket {
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private tokens: number;
  private lastRefillMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TokenBucketOptions = {}) {
    const tokensPerMinute = options.tokensPerMinute ?? 80;
    if (!Number.isFinite(tokensPerMinute) || tokensPerMinute <= 0) {
      throw new RangeError("TokenBucket: tokensPerMinute must be positive");
    }
    this.capacity = options.capacity ?? tokensPerMinute;
    if (!Number.isFinite(this.capacity) || this.capacity <= 0) {
      throw new RangeError("TokenBucket: capacity must be positive");
    }
    this.refillPerMs = tokensPerMinute / 60_000;
    this.tokens = this.capacity;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.lastRefillMs = this.now();
  }

  /** Recharges `tokens` from the elapsed time, capped at `capacity`. */
  private refill(): void {
    const elapsedMs = this.now() - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefillMs = this.now();
  }

  /**
   * Consumes `weight` tokens, waiting as long as needed for the refill.
   * Monotonic clock: a test can advance `now()` past the wait and `take`
   * resolves without sleeping.
   */
  async take(weight = 1): Promise<void> {
    if (weight <= 0) {
      throw new RangeError("TokenBucket take: weight must be positive");
    }
    for (;;) {
      this.refill();
      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }
      const missing = weight - this.tokens;
      const waitMs = Math.ceil((missing / this.refillPerMs) * 1_000) + 1;
      const targetMs = this.now() + waitMs;
      if (this.now() >= targetMs) {
        continue;
      }
      await this.sleep(waitMs);
    }
  }
}