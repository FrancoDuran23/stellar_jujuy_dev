// Events cursor for the close_start monitor (design 4.3). A single mutable
// record, so the append-only trick does not apply here: write `.tmp`,
// `fsync`, then `rename`. `rename` over an existing file is atomic on both
// POSIX and NTFS, which is what makes a mid-write crash leave the previous
// file untouched.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export type EventsCursor = {
  v: 1;
  channel: string;
  lastLedger: number;
  lastCursor: string;
  updatedAt: string;
};

const eventsCursorSchema = z.object({
  v: z.literal(1),
  channel: z.string().min(1),
  lastLedger: z.number().int().nonnegative(),
  lastCursor: z.string().min(1),
  updatedAt: z.string().min(1),
});

function warn(reason: string, filePath: string, detail: string): void {
  console.warn(JSON.stringify({ level: "warn", reason, filePath, detail }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the persisted cursor, or `undefined` if the file does not exist,
 * does not parse, or (when `expectedChannel` is given) belongs to a
 * different channel. A missing/corrupt cursor is not fatal here — the
 * caller (the close_start monitor, a later work unit) falls back to
 * `deployLedger` or `latestLedger - CLOSE_MONITOR_LOOKBACK_LEDGERS` (design
 * 4.2) — but "not fatal" must never mean "silent" (review finding, Lote C):
 * invalid JSON, a shape that fails the schema, and a channel mismatch each
 * emit a WARN before falling back, exactly like `voucher-log.ts` does for a
 * corrupt trailing line.
 *
 * `expectedChannel`, when given, guards against serving a stale cursor left
 * over from a previous channel (e.g. a channel closed and a new one opened
 * against the same `DATA_DIR` without clearing `data/events-cursor-*.json`):
 * replaying a monitor from a wrong channel's `lastLedger` would silently
 * miss that channel's real `close_start`.
 */
export function readCursor(filePath: string, expectedChannel?: string): EventsCursor | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    warn("events_cursor_invalid_json", filePath, messageOf(error));
    return undefined;
  }
  const result = eventsCursorSchema.safeParse(parsed);
  if (!result.success) {
    warn("events_cursor_invalid_shape", filePath, result.error.message);
    return undefined;
  }
  if (expectedChannel !== undefined && result.data.channel !== expectedChannel) {
    warn(
      "events_cursor_channel_mismatch",
      filePath,
      `cursor is for channel ${result.data.channel}, expected ${expectedChannel}`,
    );
    return undefined;
  }
  return result.data;
}

/**
 * Atomically writes the cursor: write to `<filePath>.tmp`, fsync that file,
 * close it, then rename over `filePath`. If the process dies before the
 * rename, `filePath` still holds whatever was there before this call.
 */
export function writeCursorSync(filePath: string, cursor: EventsCursor): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, JSON.stringify(cursor));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}
