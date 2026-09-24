import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCursor, writeCursorSync, type EventsCursor } from "./cursor.ts";

// A real-looking 56-char Soroban contract id (`^C[A-Z2-7]{55}$`), not a
// short placeholder — review finding, Lote C: fixtures should look like the
// real thing they stand in for.
const CHANNEL = `C${"A".repeat(55)}`;
const OTHER_CHANNEL = `C${"B".repeat(55)}`;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
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

function cursor(overrides: Partial<EventsCursor> = {}): EventsCursor {
  return {
    v: 1,
    channel: CHANNEL,
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

test("readCursor warns and returns undefined for invalid JSON without throwing (review finding, Lote C)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  fs.writeFileSync(filePath, "{not valid json");
  const { result, warnCalls } = withCapturedWarn(() => readCursor(filePath));
  assert.equal(result, undefined);
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0]![0]), /events_cursor_invalid_json/);
});

test("readCursor warns and returns undefined when the shape does not match the schema (review finding, Lote C)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  fs.writeFileSync(filePath, JSON.stringify({ v: 1, channel: CHANNEL }));
  const { result, warnCalls } = withCapturedWarn(() => readCursor(filePath));
  assert.equal(result, undefined);
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0]![0]), /events_cursor_invalid_shape/);
});

test("readCursor accepts a cursor whose channel matches expectedChannel", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  const value = cursor({ channel: CHANNEL });
  writeCursorSync(filePath, value);
  assert.deepEqual(readCursor(filePath, CHANNEL), value);
});

test("readCursor warns and rejects a cursor for a different channel (review finding, Lote C)", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "events-cursor-testnet.json");
  writeCursorSync(filePath, cursor({ channel: CHANNEL }));

  const { result, warnCalls } = withCapturedWarn(() => readCursor(filePath, OTHER_CHANNEL));
  assert.equal(result, undefined);
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0]![0]), /events_cursor_channel_mismatch/);
});
