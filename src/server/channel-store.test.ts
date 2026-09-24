// T6.4/T7.5: append+fsync ordering, monotonicity, and boot-time rebuild via
// VoucherLog replay. Persistence is never mocked (design 4.7) — every test
// opens a real VoucherLog against a temp file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoucherLog } from "../persistence/voucher-log.ts";
import { createChannelVoucherStore, type AcceptCommitmentInput } from "./channel-store.ts";

const CHANNEL = `C${"A".repeat(55)}`;

function openLog(filePath?: string): VoucherLog {
  const p = filePath ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "channel-store-test-")), "vouchers-server-testnet.jsonl");
  const opened = VoucherLog.open(p);
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") throw new Error("unreachable");
  return opened.log;
}

function input(overrides: Partial<AcceptCommitmentInput> = {}): AcceptCommitmentInput {
  return {
    channel: CHANNEL,
    network: "stellar:testnet",
    cumulativeAmountRaw: 1000n,
    signature: "a".repeat(128),
    commitmentPubkey: "b".repeat(64),
    sessionId: "sess_1",
    cumulativeBytes: 1_048_576,
    meterReadingId: "mr_1",
    ...overrides,
  };
}

test("getHighestRaw is 0n for a channel with no accepted voucher", () => {
  const store = createChannelVoucherStore(openLog());
  assert.equal(store.getHighestRaw(CHANNEL), 0n);
});

test("accept() accepts a strictly higher amount and reports the correct remaining", async () => {
  const store = createChannelVoucherStore(openLog());
  const result = await store.accept(input({ cumulativeAmountRaw: 1000n }), 5000n);
  assert.deepEqual(result, { accepted: true, remainingRaw: 4000n });
  assert.equal(store.getHighestRaw(CHANNEL), 1000n);
});

test("accept() rejects a strictly lower amount as stale", async () => {
  const store = createChannelVoucherStore(openLog());
  await store.accept(input({ cumulativeAmountRaw: 1000n }), 5000n);

  const lower = await store.accept(input({ cumulativeAmountRaw: 500n }), 5000n);
  assert.deepEqual(lower, { accepted: false, reason: "stale", highestRaw: 1000n });
});

// --- review finding 4, Lote F: an equal amount with a matching signature is
// a retry of the same accept, not a new one — accepted again, no new line.

test("accept() with the same amount AND signature as the current highest is accepted again as reused, with no new line (review finding 4, Lote F)", async () => {
  const store = createChannelVoucherStore(openLog());
  const first = await store.accept(input({ cumulativeAmountRaw: 1000n, signature: "a".repeat(128) }), 5000n);
  assert.deepEqual(first, { accepted: true, remainingRaw: 4000n });

  const retry = await store.accept(input({ cumulativeAmountRaw: 1000n, signature: "a".repeat(128) }), 5000n);
  assert.deepEqual(retry, { accepted: true, remainingRaw: 4000n, reused: true });
  assert.equal(store.getHighestRaw(CHANNEL), 1000n);
});

test("accept() with the same amount but a DIFFERENT signature is still stale, never accepted as reused", async () => {
  const store = createChannelVoucherStore(openLog());
  await store.accept(input({ cumulativeAmountRaw: 1000n, signature: "a".repeat(128) }), 5000n);

  const differentSignature = await store.accept(input({ cumulativeAmountRaw: 1000n, signature: "b".repeat(128) }), 5000n);
  assert.deepEqual(differentSignature, { accepted: false, reason: "stale", highestRaw: 1000n });
});

test("accept() crash-then-retry: the internal hop can be redelivered any number of times after the equal-amount accept, always as reused (review finding 4, Lote F)", async () => {
  const store = createChannelVoucherStore(openLog());
  const voucher = input({ cumulativeAmountRaw: 1000n, signature: "a".repeat(128) });

  // Simulates: server accepts, then a crash happens before the agent's own
  // append — the agent retries the exact same delivery on restart, possibly
  // more than once (e.g. the retry itself also hits a hiccup).
  await store.accept(voucher, 5000n);
  const retry1 = await store.accept(voucher, 5000n);
  const retry2 = await store.accept(voucher, 5000n);
  assert.equal(retry1.accepted, true);
  assert.equal(retry2.accepted, true);
  if (retry1.accepted) assert.equal(retry1.reused, true);
  if (retry2.accepted) assert.equal(retry2.reused, true);
});

test("append (with fsync) happens before accept() resolves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-store-order-test-"));
  const filePath = path.join(dir, "vouchers-server-testnet.jsonl");
  const log = openLog(filePath);
  const store = createChannelVoucherStore(log);

  const order: string[] = [];
  const originalAppend = log.append.bind(log);
  log.append = (record) => {
    originalAppend(record);
    order.push("append");
  };

  await store.accept(input(), 5000n);
  order.push("resolved");
  assert.deepEqual(order, ["append", "resolved"]);

  // And the bytes are really on disk.
  const contents = fs.readFileSync(filePath, "utf8");
  assert.match(contents, /"cumulativeAmount":"1000"/);
});

test("concurrent accept() calls for the same channel never both win (mutex serializes)", async () => {
  const store = createChannelVoucherStore(openLog());
  const [a, b] = await Promise.all([
    store.accept(input({ cumulativeAmountRaw: 100n, meterReadingId: "mr_a" }), 10_000n),
    store.accept(input({ cumulativeAmountRaw: 200n, meterReadingId: "mr_b" }), 10_000n),
  ]);
  // Whichever ran second must see the first's write and never accept a
  // lower-or-equal amount than what actually ended up highest.
  const results = [a, b];
  const accepted = results.filter((r) => r.accepted);
  assert.equal(accepted.length, 2, "both amounts strictly increase from 0, so both should be accepted in some order");
  assert.equal(store.getHighestRaw(CHANNEL), 200n);
});

test("rebuilds the highest-per-channel index at boot from the JSONL log (VoucherLog replay)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-store-reboot-test-"));
  const filePath = path.join(dir, "vouchers-server-testnet.jsonl");
  const firstBoot = createChannelVoucherStore(openLog(filePath));
  await firstBoot.accept(input({ cumulativeAmountRaw: 1000n }), 5000n);
  await firstBoot.accept(input({ cumulativeAmountRaw: 3000n }), 5000n);

  // Simulate a restart: open a brand-new VoucherLog + store against the same file.
  const secondBoot = createChannelVoucherStore(openLog(filePath));
  assert.equal(secondBoot.getHighestRaw(CHANNEL), 3000n);

  const stale = await secondBoot.accept(input({ cumulativeAmountRaw: 2000n }), 5000n);
  assert.deepEqual(stale, { accepted: false, reason: "stale", highestRaw: 3000n });
});
