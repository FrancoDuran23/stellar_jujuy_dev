import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { channelRecordPath, readChannelRecord, writeChannelRecord, type ChannelRecord } from "./channel-record.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "channel-record-test-"));
}

test("channelRecordPath builds the per-network file name", () => {
  assert.equal(channelRecordPath("./data", "stellar:testnet"), path.join("./data", "channel-stellar-testnet.json"));
});

test("channelRecordPath strips ':' so the file survives a rename on Windows (NTFS ADS gotcha)", () => {
  const dir = tempDir();
  const filePath = channelRecordPath(dir, "stellar:testnet");
  assert.equal(filePath.includes(":testnet"), false);
  // A rename-based write (writeChannelRecord's .tmp -> rename sequence)
  // throws EINVAL on Windows for a literal "channel-stellar:testnet.json"
  // path — this only proves the sanitized path is rename-safe.
  writeChannelRecord(filePath, {
    v: 1,
    channel: `C${"C".repeat(55)}`,
    txHash: "sanitized",
    depositRaw: "1",
    refundWaitingPeriodLedgers: 60,
    deployLedger: 1,
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(readChannelRecord(filePath)?.txHash, "sanitized");
});

test("readChannelRecord returns undefined for a missing file", () => {
  const dir = tempDir();
  assert.equal(readChannelRecord(path.join(dir, "nope.json")), undefined);
});

test("write then read round-trips the record", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "channel-stellar-testnet.json");
  const record: ChannelRecord = {
    v: 1,
    channel: `C${"A".repeat(55)}`,
    txHash: "abc123",
    depositRaw: "50000000",
    refundWaitingPeriodLedgers: 60,
    deployLedger: 4700000,
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
  writeChannelRecord(filePath, record);
  assert.deepEqual(readChannelRecord(filePath), record);
});

test("readChannelRecord returns undefined for a corrupt file (never throws)", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "channel-stellar-testnet.json");
  fs.writeFileSync(filePath, "{not json");
  assert.equal(readChannelRecord(filePath), undefined);
});

test("writeChannelRecord overwrites atomically (no .tmp left behind)", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "channel-stellar-testnet.json");
  const record: ChannelRecord = {
    v: 1,
    channel: `C${"B".repeat(55)}`,
    txHash: "first",
    depositRaw: "1000",
    refundWaitingPeriodLedgers: 60,
    deployLedger: 1,
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
  writeChannelRecord(filePath, record);
  writeChannelRecord(filePath, { ...record, depositRaw: "2000", txHash: "second" });
  assert.equal(readChannelRecord(filePath)?.depositRaw, "2000");
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});
