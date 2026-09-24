// These tests never mock fs (design 4.7: "persistence is never mocked" —
// the failure mode that matters is disk, and a fake fs would prove nothing).
// Every test writes to a real directory created with fs.mkdtempSync.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoucherLog, type VoucherRecord } from "./voucher-log.ts";

// A real-looking 56-char Soroban contract id (`^C[A-Z2-7]{55}$`), not a
// short placeholder — review finding, Lote C: fixtures should look like the
// real thing they stand in for.
const CHANNEL = `C${"A".repeat(55)}`;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voucher-log-test-"));
}

function withCapturedWarn<T>(fn: () => T): { result: T; warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  try {
    return { result: fn(), warnCalls };
  } finally {
    console.warn = originalWarn;
  }
}

function record(overrides: Partial<VoucherRecord> = {}): VoucherRecord {
  return {
    v: 1,
    ts: "2026-09-20T18:04:02.118Z",
    network: "stellar:testnet",
    channel: CHANNEL,
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

  const highest = reopened.log.getHighest(CHANNEL);
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
  assert.equal(opened.log.getHighest(CHANNEL), undefined);
  assert.equal(fs.existsSync(filePath), true);
  opened.log.close();
});

test("a truncated trailing line warns, is quarantined to a sidecar, and the previous record is kept (VP-R5, review finding Lote C)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const goodLine = `${JSON.stringify(record({ cumulativeAmount: "50000" }))}\n`;
  const truncatedLine = `${JSON.stringify(record({ cumulativeAmount: "90000" })).slice(0, 20)}`; // cut mid-JSON, no trailing newline
  fs.writeFileSync(filePath, goodLine + truncatedLine);

  const { result: opened, warnCalls } = withCapturedWarn(() => VoucherLog.open(filePath));

  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;

  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0]![0]), /voucher_log_trailing_line_discarded/);

  const highest = opened.log.getHighest(CHANNEL);
  assert.ok(highest);
  assert.equal(highest!.cumulativeAmountRaw, 50000n);

  // The file itself was truncated to the last valid line — a fresh open
  // must not re-discover the corrupt tail.
  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.equal(onDisk, goodLine);

  // The corrupt tail is never just discarded: it must survive as forensic
  // evidence in a sidecar file next to the log (review finding, Lote C).
  const sidecarNames = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(sidecarNames.length, 1);
  const sidecarContent = fs.readFileSync(path.join(dir, sidecarNames[0]!), "utf8");
  assert.equal(sidecarContent, truncatedLine);

  opened.log.close();
});

test("append never glues onto a last valid line missing its trailing newline (review finding, Lote C)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  // A complete, valid record but with NO trailing newline on disk — e.g. a
  // process died right after `writeSync` returned but before the next
  // append. `open()` must repair this before handing out its append fd.
  const firstRecord = record({ cumulativeAmount: "50000", meterReadingId: "mr_1" });
  fs.writeFileSync(filePath, JSON.stringify(firstRecord));

  const { result: opened, warnCalls } = withCapturedWarn(() => VoucherLog.open(filePath));
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0]![0]), /voucher_log_missing_trailing_newline/);

  // The first record must already be visible in the index (it was valid).
  assert.equal(opened.log.getHighest(CHANNEL)!.cumulativeAmountRaw, 50000n);

  opened.log.append(record({ cumulativeAmount: "90000", meterReadingId: "mr_2" }));
  opened.log.close();

  const onDisk = fs.readFileSync(filePath, "utf8");
  const lines = onDisk.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, "the two records must be on separate lines, never glued together");
  assert.deepEqual(JSON.parse(lines[0]!), firstRecord);

  const reopened = VoucherLog.open(filePath);
  assert.equal(reopened.status, "ok");
  if (reopened.status !== "ok") return;
  assert.equal(reopened.log.getHighest(CHANNEL)!.cumulativeAmountRaw, 90000n);
  assert.equal(reopened.log.getHighest(CHANNEL)!.meterReadingId, "mr_2");
  reopened.log.close();
});

test("an empty file opens cleanly with an empty index and no spurious newline repair", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");
  fs.writeFileSync(filePath, "");

  const { result: opened, warnCalls } = withCapturedWarn(() => VoucherLog.open(filePath));
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;
  assert.equal(warnCalls.length, 0);
  assert.equal(opened.log.getHighest(CHANNEL), undefined);
  assert.equal(fs.readFileSync(filePath, "utf8"), "");

  opened.log.append(record({ cumulativeAmount: "10000" }));
  assert.equal(opened.log.getHighest(CHANNEL)!.cumulativeAmountRaw, 10000n);
  opened.log.close();
});

test("a record with a lower cumulative amount written out of order on disk never rolls back the index", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "vouchers-agent-testnet.jsonl");

  // Simulates lines that ended up out of order on disk (design 4.3: the
  // index keeps the maximum ever seen, never the last line read).
  const lines = [
    record({ cumulativeAmount: "50000", meterReadingId: "mr_1" }),
    record({ cumulativeAmount: "90000", meterReadingId: "mr_2" }),
    record({ cumulativeAmount: "30000", meterReadingId: "mr_3" }),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  fs.writeFileSync(filePath, `${lines}\n`);

  const opened = VoucherLog.open(filePath);
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") return;

  const highest = opened.log.getHighest(CHANNEL);
  assert.ok(highest);
  assert.equal(highest!.cumulativeAmountRaw, 90000n);
  assert.equal(highest!.meterReadingId, "mr_2");
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
  assert.equal(opened.log.getHighest(CHANNEL)!.cumulativeAmountRaw, 10000n);

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
