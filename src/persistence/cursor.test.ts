import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCursor, writeCursorSync, type EventsCursor } from "./cursor.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
}

function cursor(overrides: Partial<EventsCursor> = {}): EventsCursor {
  return {
    v: 1,
    channel: "CB1234567890",
    lastLedger: 1234567,
    lastCursor: "0000005300000000-0000000000",
    updatedAt: "2026-09-20T18:04:02.118Z",
    ...overrides,
  };
}

test("readCursor returns undefined when the file does not exist", () => {
  const dir = makeTempDir();
  assert.equal(readCursor(path.join(dir, "events-cursor-testnet.json")), undefined);
});

test("writeCursorSync then readCursor round-trips the exact value", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  const value = cursor();

  writeCursorSync(filePath, value);
  assert.deepEqual(readCursor(filePath), value);
});

test("writeCursorSync overwrites the previous value atomically", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");

  writeCursorSync(filePath, cursor({ lastLedger: 1 }));
  writeCursorSync(filePath, cursor({ lastLedger: 2 }));

  assert.equal(readCursor(filePath)!.lastLedger, 2);
  // No leftover .tmp file after a successful write.
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test("a write interrupted before rename leaves the previous value intact", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");

  const previous = cursor({ lastLedger: 100 });
  writeCursorSync(filePath, previous);

  // Simulate a crash mid-write: a partial .tmp file exists on disk, but the
  // real file was never renamed over.
  fs.writeFileSync(`${filePath}.tmp`, '{"v":1,"channel":"CB1234567890","lastLedge');

  assert.deepEqual(readCursor(filePath), previous);
});

test("readCursor returns undefined for invalid JSON without throwing", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  fs.writeFileSync(filePath, "{not valid json");
  assert.equal(readCursor(filePath), undefined);
});

test("readCursor returns undefined when the shape does not match the schema", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  fs.writeFileSync(filePath, JSON.stringify({ v: 1, channel: "CB1234567890" }));
  assert.equal(readCursor(filePath), undefined);
});
