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

/**
 * Reads the persisted cursor, or `undefined` if the file does not exist or
 * does not parse. A missing/corrupt cursor is not fatal here — the caller
 * (the close_start monitor, a later work unit) falls back to `deployLedger`
 * or `latestLedger - CLOSE_MONITOR_LOOKBACK_LEDGERS` (design 4.2).
 */
export function readCursor(filePath: string): EventsCursor | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
  const result = eventsCursorSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
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
