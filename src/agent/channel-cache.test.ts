// T6.3: RpcPort fake — local exhaustion/caching behavior without any network
// access.

import test from "node:test";
import assert from "node:assert/strict";
import { createChannelCache, type ChannelRpcPort, type ContractChannelInfo } from "./channel-cache.ts";

const CHANNEL = `C${"A".repeat(55)}`;

function fakeRpcPort(sequence: ContractChannelInfo[]): ChannelRpcPort & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getContractChannelInfo() {
      const info = sequence[Math.min(calls, sequence.length - 1)]!;
      calls += 1;
      return info;
    },
  };
}

test("returns open + depositRaw for a found, non-closing channel", async () => {
  const port = fakeRpcPort([{ found: true, depositRaw: 5_000_000n, closing: false }]);
  const cache = createChannelCache(port);
  const info = await cache.getChannelInfo(CHANNEL);
  assert.deepEqual(info, { status: "open", depositRaw: 5_000_000n });
});

test("maps closing:true to status closing", async () => {
  const port = fakeRpcPort([{ found: true, depositRaw: 5_000_000n, closing: true }]);
  const cache = createChannelCache(port);
  const info = await cache.getChannelInfo(CHANNEL);
  assert.deepEqual(info, { status: "closing", depositRaw: 5_000_000n });
});

test("maps found:false to status not_found", async () => {
  const port = fakeRpcPort([{ found: false }]);
  const cache = createChannelCache(port);
  const info = await cache.getChannelInfo(CHANNEL);
  assert.deepEqual(info, { status: "not_found" });
});

test("caches within the TTL window: a second call before expiry never re-queries", async () => {
  let clock = 0;
  const port = fakeRpcPort([{ found: true, depositRaw: 1_000n, closing: false }]);
  const cache = createChannelCache(port, { ttlMs: 1000, now: () => clock });

  await cache.getChannelInfo(CHANNEL);
  clock += 500;
  await cache.getChannelInfo(CHANNEL);
  assert.equal(port.calls, 1);
});

test("re-queries once the TTL expires, picking up a top-up or a close_start", async () => {
  let clock = 0;
  const port = fakeRpcPort([
    { found: true, depositRaw: 1_000n, closing: false },
    { found: true, depositRaw: 1_000n, closing: true },
  ]);
  const cache = createChannelCache(port, { ttlMs: 1000, now: () => clock });

  const first = await cache.getChannelInfo(CHANNEL);
  assert.deepEqual(first, { status: "open", depositRaw: 1_000n });

  clock += 1001;
  const second = await cache.getChannelInfo(CHANNEL);
  assert.deepEqual(second, { status: "closing", depositRaw: 1_000n });
  assert.equal(port.calls, 2);
});

test("caches independently per channel", async () => {
  const otherChannel = `C${"B".repeat(55)}`;
  let calls = 0;
  const port: ChannelRpcPort = {
    async getContractChannelInfo(channel) {
      calls += 1;
      return channel === CHANNEL
        ? { found: true, depositRaw: 1n, closing: false }
        : { found: true, depositRaw: 2n, closing: false };
    },
  };
  const cache = createChannelCache(port, { ttlMs: 10_000 });

  const a = await cache.getChannelInfo(CHANNEL);
  const b = await cache.getChannelInfo(otherChannel);
  assert.deepEqual(a, { status: "open", depositRaw: 1n });
  assert.deepEqual(b, { status: "open", depositRaw: 2n });
  assert.equal(calls, 2);
});
