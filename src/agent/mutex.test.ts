import { test } from "node:test";
import assert from "node:assert/strict";
import { createChannelMutex } from "./mutex.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("two concurrent calls on the same channel are serialized (VE-R12)", async () => {
  const mutex = createChannelMutex();
  const events: string[] = [];
  const first = deferred<void>();

  const call1 = mutex.withChannelLock("channel-a", async () => {
    events.push("call1-start");
    await first.promise;
    events.push("call1-end");
    return "one";
  });

  // Give call1 a chance to actually start before queuing call2.
  await Promise.resolve();
  await Promise.resolve();

  const call2 = mutex.withChannelLock("channel-a", async () => {
    events.push("call2-start");
    return "two";
  });

  // call2 must not have started yet: call1 is still awaiting `first`.
  assert.deepEqual(events, ["call1-start"]);

  first.resolve();
  const [result1, result2] = await Promise.all([call1, call2]);

  assert.equal(result1, "one");
  assert.equal(result2, "two");
  assert.deepEqual(events, ["call1-start", "call1-end", "call2-start"]);
});

test("channels are independent: a slow call on one channel never blocks another channel", async () => {
  const mutex = createChannelMutex();
  const blocked = deferred<void>();
  const events: string[] = [];

  const slow = mutex.withChannelLock("channel-a", async () => {
    events.push("a-start");
    await blocked.promise;
    events.push("a-end");
  });

  const fast = mutex.withChannelLock("channel-b", async () => {
    events.push("b-start");
    events.push("b-end");
  });

  await fast;
  assert.deepEqual(events, ["a-start", "b-start", "b-end"]);

  blocked.resolve();
  await slow;
  assert.deepEqual(events, ["a-start", "b-start", "b-end", "a-end"]);
});

test("a failure in one call never poisons the chain for the next queued call on the same channel", async () => {
  const mutex = createChannelMutex();

  const call1 = mutex.withChannelLock("channel-a", async () => {
    throw new Error("boom");
  });
  const call2 = mutex.withChannelLock("channel-a", async () => "recovered");

  await assert.rejects(call1, /boom/);
  assert.equal(await call2, "recovered");
});

test("the caller receives fn's real rejection, not a mutex-wrapped error", async () => {
  const mutex = createChannelMutex();
  class CustomError extends Error {}
  await assert.rejects(
    mutex.withChannelLock("channel-a", async () => {
      throw new CustomError("specific failure");
    }),
    CustomError,
  );
});
