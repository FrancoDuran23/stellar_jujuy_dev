// Append-only voucher log (design 4.3; spec 3.4, VP-R1..VP-R8). One file per
// role and network (`data/vouchers-{role}-{network}.jsonl`) so two processes
// never share a descriptor over the same append-only file.
//
// Order that must never move: append, fsync, and only then acknowledge the
// caller (VP-R3). This module never acknowledges before `fsync` returns.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isHex64, isHex128 } from "../shared/stellar/keys.ts";

export type VoucherRecord = {
  v: 1;
  ts: string;
  network: string;
  channel: string;
  sessionId: string;
  cumulativeAmount: string;
  cumulativeBytes: number;
  signature: string;
  commitmentPubkey: string;
  meterReadingId: string;
};

export type VoucherIndexEntry = {
  cumulativeAmountRaw: bigint;
  signature: string;
  cumulativeBytes: number;
  commitmentPubkey: string;
  meterReadingId: string;
  ts: string;
};

export type OpenVoucherLogResult =
  | { status: "ok"; log: VoucherLog }
  | { status: "corrupt"; reason: "voucher_log_corrupt"; detail: string };

const voucherRecordSchema = z.object({
  v: z.literal(1),
  ts: z.string().min(1),
  network: z.string().min(1),
  channel: z.string().min(1),
  sessionId: z.string().min(1),
  cumulativeAmount: z.string().regex(/^\d+$/),
  cumulativeBytes: z.number().int().nonnegative(),
  signature: z.string().refine(isHex128, "signature must be 128 hex chars"),
  commitmentPubkey: z.string().refine(isHex64, "commitmentPubkey must be 64 hex chars"),
  meterReadingId: z.string().min(1),
});

function parseLine(line: string): VoucherRecord | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = voucherRecordSchema.safeParse(candidate);
  return result.success ? (result.data as VoucherRecord) : undefined;
}

function updateIndex(index: Map<string, VoucherIndexEntry>, record: VoucherRecord): void {
  const cumulativeAmountRaw = BigInt(record.cumulativeAmount);
  const existing = index.get(record.channel);
  // Keep the maximum ever seen, not the last line read (design 4.3): a
  // reused (non-appended) request never regresses it, and out-of-order
  // lines on disk — however unlikely — never regress it either.
  if (existing !== undefined && existing.cumulativeAmountRaw >= cumulativeAmountRaw) {
    return;
  }
  index.set(record.channel, {
    cumulativeAmountRaw,
    signature: record.signature,
    cumulativeBytes: record.cumulativeBytes,
    commitmentPubkey: record.commitmentPubkey,
    meterReadingId: record.meterReadingId,
    ts: record.ts,
  });
}

type ReplayWarning =
  | { kind: "trailing_discarded"; detail: string }
  | { kind: "corrupt_middle"; detail: string };

type ReplayResult = {
  index: Map<string, VoucherIndexEntry>;
  warning?: ReplayWarning;
  validByteLength: number;
};

function replay(filePath: string): ReplayResult {
  const index = new Map<string, VoucherIndexEntry>();
  if (!fs.existsSync(filePath)) {
    return { index, validByteLength: 0 };
  }
  const content = fs.readFileSync(filePath, "utf8");
  if (content.length === 0) {
    return { index, validByteLength: 0 };
  }
  const endsWithNewline = content.endsWith("\n");
  const rawLines = content.split("\n");
  const lines = endsWithNewline ? rawLines.slice(0, -1) : rawLines;

  let validByteLength = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isLastLine = i === lines.length - 1;
    const parsed = parseLine(line);
    if (parsed === undefined) {
      if (isLastLine) {
        return {
          index,
          validByteLength,
          warning: {
            kind: "trailing_discarded",
            detail: `line ${i + 1} of ${filePath} is truncated or not valid JSON`,
          },
        };
      }
      return {
        index,
        validByteLength,
        warning: {
          kind: "corrupt_middle",
          detail: `line ${i + 1} of ${filePath} is corrupt and is not the last line`,
        },
      };
    }
    validByteLength += Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
    updateIndex(index, parsed);
  }
  return { index, validByteLength };
}

export class VoucherLog {
  private readonly filePath: string;
  private readonly fd: number;
  private readonly index: Map<string, VoucherIndexEntry>;

  private constructor(filePath: string, fd: number, index: Map<string, VoucherIndexEntry>) {
    this.filePath = filePath;
    this.fd = fd;
    this.index = index;
  }

  /**
   * Opens (creating if needed) the log at `filePath`, replaying it to
   * reconstruct the highest-cumulative-amount index (VP-R4).
   *
   * - Missing file: created empty, empty index (VP-R4).
   * - Corrupt/truncated trailing line: WARN, truncate to the last valid
   *   line, keep serving (VP-R5).
   * - Corrupt line that is not the last one: `status: "corrupt"` — the
   *   caller (config/boot.ts, a later work unit) turns this into
   *   `unavailable` with `reason: "voucher_log_corrupt"` (VP-R6).
   */
  static open(filePath: string): OpenVoucherLogResult {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const result = replay(filePath);

    if (result.warning?.kind === "corrupt_middle") {
      return { status: "corrupt", reason: "voucher_log_corrupt", detail: result.warning.detail };
    }

    if (result.warning?.kind === "trailing_discarded") {
      console.warn(
        JSON.stringify({
          level: "warn",
          reason: "voucher_log_trailing_line_discarded",
          detail: result.warning.detail,
          filePath,
        }),
      );
      fs.truncateSync(filePath, result.validByteLength);
    }

    const fd = fs.openSync(filePath, "a");
    return { status: "ok", log: new VoucherLog(filePath, fd, result.index) };
  }

  /** The highest accepted voucher for `channel`, or `undefined` if none. */
  getHighest(channel: string): VoucherIndexEntry | undefined {
    return this.index.get(channel);
  }

  /**
   * Appends one record and fsyncs before returning (VP-R3). The log is
   * never rewritten, truncated, or compacted here (VP-R7) — this is the
   * only write path besides the trailing-line truncation done once at
   * `open()`.
   */
  append(record: VoucherRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    updateIndex(this.index, record);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  get path(): string {
    return this.filePath;
  }
}
