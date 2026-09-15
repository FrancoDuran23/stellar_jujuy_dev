import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
  RetryDeadlineExceededError,
  computeBackoffDelayMs,
  withRetry,
} from "./retry.ts";

test("RETRY_MAX_ATTEMPTS is 4 (1 attempt + 3 retries)", () => {
  assert.equal(RETRY_MAX_ATTEMPTS, 4);
});

test("computeBackoffDelayMs is bounded by min(base * 2^attempt, cap)", () => {
  const random = () => 1; // force the upper bound
  assert.equal(computeBackoffDelayMs(0, { random }), 250);
  assert.equal(computeBackoffDelayMs(1, { random }), 500);
  // 250 * 2^2 = 1000, exactly RETRY_MAX_DELAY_MS: the cap and the natural
  // growth coincide at the last retry `withRetry` ever sleeps for by
  // default (review finding, Lote C — the cap used to be unreachable under
  // the default 4-attempt loop; it now binds exactly here).
  assert.equal(computeBackoffDelayMs(2, { random }), RETRY_MAX_DELAY_MS);
  // 250 * 2^4 = 4000, must be capped at RETRY_MAX_DELAY_MS
  assert.equal(computeBackoffDelayMs(4, { random }), RETRY_MAX_DELAY_MS);
  // 250 * 2^5 = 8000, must be capped at RETRY_MAX_DELAY_MS
  assert.equal(computeBackoffDelayMs(5, { random }), RETRY_MAX_DELAY_MS);
});

test("computeBackoffDelayMs never exceeds RETRY_MAX_DELAY_MS regardless of jitter", () => {
  for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = computeBackoffDelayMs(attempt, { random: () => random });
      assert.ok(delay >= 0, `delay ${delay} must be >= 0`);
      assert.ok(delay <= RETRY_MAX_DELAY_MS, `delay ${delay} must be <= ${RETRY_MAX_DELAY_MS}`);
    }
  }
});

test("withRetry resolves immediately when fn succeeds on the first attempt", async () => {
  const delays: number[] = [];
  const result = await withRetry(async () => "ok", {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(result, "ok");
  assert.deepEqual(delays, []);
});

test("withRetry retries up to maxAttempts and then throws the last error", async () => {
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls} failed`);
        },
        {
          maxAttempts: 4,
          random: () => 0, // deterministic (0ms) delays, no real waiting
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    /attempt 4 failed/,
  );
  assert.equal(calls, 4);
  assert.equal(delays.length, 3); // one sleep between each pair of attempts
});

test("withRetry does not retry when isRetryable returns false", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error("invalid signature");
        },
        { isRetryable: () => false, sleep: async () => {} },
      ),
    /invalid signature/,
  );
  assert.equal(calls, 1);
});

test("withRetry succeeds after a transient failure", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("upstream_unavailable");
      }
      return "recovered";
    },
    { random: () => 0, sleep: async () => {} },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

// --- deadlineMs / attemptTimeoutMs (review finding, Lote C: only sleeps
// were bounded before, not the total wall-clock time of a call) ---

test("withRetry throws RetryDeadlineExceededError instead of sleeping once the next delay would exceed the deadline", async () => {
  let calls = 0;
  let clock = 0;
  const advance = (ms: number) => {
    clock += ms;
  };
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          advance(900); // each attempt itself takes time
          throw new Error("upstream_unavailable");
        },
        {
          deadlineMs: 1000,
          random: () => 1, // force the maximum jitter: attempt 0's delay is 250ms
          now: () => clock,
          sleep: async (ms) => {
            advance(ms);
          },
        },
      ),
    (error: unknown) => error instanceof RetryDeadlineExceededError,
  );
  // One attempt runs (clock 0 -> 900). Its retry delay would be 250ms,
  // and 900 + 250 >= 1000, so the deadline check fires before sleeping and
  // a second attempt never starts.
  assert.equal(calls, 1);
});

test("withRetry checks the deadline before the very first attempt too", async () => {
  let calls = 0;
  let clockReads = 0;
  // First read is `startedAt` (0); every read after that is already past
  // the 10ms deadline, simulating time that passed before withRetry was
  // even called (e.g. queued behind other work).
  const now = () => (clockReads++ === 0 ? 0 : 100);
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          return "unreachable";
        },
        { deadlineMs: 10, now },
      ),
    (error: unknown) => error instanceof RetryDeadlineExceededError,
  );
  assert.equal(calls, 0);
});

test("withRetry does not throw a deadline error when every attempt finishes comfortably inside it", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error("upstream_unavailable");
      return "ok";
    },
    { deadlineMs: 60_000, random: () => 0, sleep: async () => {} },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry's attemptTimeoutMs aborts a single hanging attempt and retries", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        // Never resolves on its own — only the attempt timeout ends it.
        return new Promise<string>(() => {});
      }
      return "recovered";
    },
    { attemptTimeoutMs: 20, random: () => 0, sleep: async () => {} },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});
