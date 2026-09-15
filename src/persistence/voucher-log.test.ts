// These tests never mock fs (design 4.7: "persistence is never mocked" —
// the failure mode that matters is disk, and a fake fs would prove nothing).
// Every test writes to a real directory created with fs.mkdtempSync.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoucherLog, type VoucherRecord } from "./voucher-log.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voucher-log-test-"));
}

function record(overrides: Partial<VoucherRecord> = {}): VoucherRecord {
  return {
    v: 1,
    ts: "2026-09-20T18:04:02.118Z",
    network: "stellar:testnet",
    channel: "CB1234567890",
    sessionId: "sess_01JBQ7X3M2",
    cumulativeAmount: "125000",
    cumulativeBytes: 1048576,
    signature: "a".repeat(128),
    commitmentPubkey: "b".repeat(64),
    meterReadingId: "mr_000001",
    ...overrides,
  };
}

test("3 appends then reopen recovers the highest cumulative amount (VP-R4)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const opened = VoucherLog.open(filePath);
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;

  opened.log.append(record({ cumulativeAmount: "50000", meterReadingId: "mr_1" }));
  opened.log.append(record({ cumulativeAmount: "90000", meterReadingId: "mr_2" }));
  opened.log.append(record({ cumulativeAmount: "125000", meterReadingId: "mr_3" }));
  opened.log.close();

  const reopened = VoucherLog.open(filePath);
  assert.equal(reopened.status, "ok");
  if (reopened.status !== "ok") return;

  const highest = reopened.log.getHighest("CB1234567890");
  assert.ok(highest);
  assert.equal(highest!.cumulativeAmountRaw, 125000n);
  assert.equal(highest!.meterReadingId, "mr_3");
  reopened.log.close();
});

test("missing file opens with an empty index and creates the file (VP-R4)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const opened = VoucherLog.open(filePath);
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;
  assert.equal(opened.log.getHighest("CB1234567890"), undefined);
  assert.equal(fs.existsSync(filePath), true);
  opened.log.close();
});

test("a truncated trailing line warns, is discarded, and the previous record is kept (VP-R5)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const goodLine = `${JSON.stringify(record({ cumulativeAmount: "50000" }))}\n`;
  const truncatedLine = `${JSON.stringify(record({ cumulativeAmount: "90000" })).slice(0, 20)}`; // cut mid-JSON, no trailing newline
  fs.writeFileSync(filePath, goodLine + truncatedLine);

  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  let opened: ReturnType<typeof VoucherLog.open>;
  try {
    opened = VoucherLog.open(filePath);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;

  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0]![0]), /voucher_log_trailing_line_discarded/);

  const highest = opened.log.getHighest("CB1234567890");
  assert.ok(highest);
  assert.equal(highest!.cumulativeAmountRaw, 50000n);

  // The file itself was truncated to the last valid line — a fresh open
  // must not re-discover the corrupt tail.
  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.equal(onDisk, goodLine);

  opened.log.close();
});

test("a corrupt line that is not the last one is reported as voucher_log_corrupt (VP-R6)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const line1 = JSON.stringify(record({ cumulativeAmount: "50000" }));
  const corruptMiddleLine = "{not valid json";
  const line3 = JSON.stringify(record({ cumulativeAmount: "125000" }));
  fs.writeFileSync(filePath, `${line1}\n${corruptMiddleLine}\n${line3}\n`);

  const opened = VoucherLog.open(filePath);
  assert.equal(opened.status, "corrupt");
  if (opened.status !== "corrupt") return;
  assert.equal(opened.reason, "voucher_log_corrupt");
  assert.match(opened.detail, /line 2/);
});

test("append fsyncs before returning and updates the index with the new max", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");
  const opened = VoucherLog.open(filePath);
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;

  opened.log.append(record({ cumulativeAmount: "10000" }));
  const onDiskAfterFirst = fs.readFileSync(filePath, "utf8");
  assert.equal(onDiskAfterFirst.trim().length > 0, true);
  assert.equal(opened.log.getHighest("CB1234567890")!.cumulativeAmountRaw, 10000n);

  opened.log.close();
});

test("the log never rewrites or truncates existing valid content on append (VP-R7)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");
  const opened = VoucherLog.open(filePath);
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;

  opened.log.append(record({ cumulativeAmount: "10000" }));
  const afterFirst = fs.readFileSync(filePath, "utf8");
  opened.log.append(record({ cumulativeAmount: "20000" }));
  const afterSecond = fs.readFileSync(filePath, "utf8");

  assert.ok(afterSecond.startsWith(afterFirst));
  opened.log.close();
});
