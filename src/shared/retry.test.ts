import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
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
  assert.equal(computeBackoffDelayMs(2, { random }), 1000);
  // 250 * 2^4 = 4000, still under the 4000ms cap
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
