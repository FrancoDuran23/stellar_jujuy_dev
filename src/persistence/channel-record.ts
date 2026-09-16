// Local channel metadata record (design 4.2: "la CLI ... deja
// `data/channel-{network}.json` con `{channel, txHash, depositRaw,
// refundWaitingPeriodLedgers, deployLedger}`. Ese archivo es evidencia, no
// configuración"). `agent/channel.ts`'s `open`/`top-up` subcommands write
// it; `config/boot.ts`'s real `ChannelRpcPort` reads it as the deposit
// source of record whenever the contract's own `deposited()` getter is
// unavailable — true for the only wasm revision deployable today (spike
// Part C: no `deposited`/`withdrawn` on this revision). `server/channel-
// admin.ts` and `close-monitor.ts` do NOT read this file — the server
// tracks the deposit independently via its own accepted-voucher store
// (`server/channel-store.ts`), never trusting a file the funder's own CLI
// could rewrite.

import fs from "node:fs";
import path from "node:path";
import { sanitizeNetworkForFilename } from "../shared/stellar/network.ts";

export type ChannelRecord = {
  v: 1;
  channel: string;
  txHash: string;
  /** Raw i128 units, as a digit string (never a bigint or number). */
  depositRaw: string;
  refundWaitingPeriodLedgers: number;
  deployLedger: number;
  updatedAt: string;
};

export function channelRecordPath(dataDir: string, network: string): string {
  return path.join(dataDir, `channel-${sanitizeNetworkForFilename(network)}.json`);
}

export function readChannelRecord(filePath: string): ChannelRecord | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      "depositRaw" in parsed
    ) {
      return parsed as ChannelRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Writes the record via a `.tmp` + `fsync` + `rename` sequence (design
 * 4.3's cursor-file pattern: `rename` over an existing file is atomic on
 * both POSIX and NTFS), so a crash mid-write never corrupts the file a
 * concurrent reader depends on. */
export function writeChannelRecord(filePath: string, record: ChannelRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    const buffer = Buffer.from(JSON.stringify(record, null, 2), "utf8");
    let written = 0;
    while (written < buffer.length) {
      written += fs.writeSync(fd, buffer, written, buffer.length - written);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}
