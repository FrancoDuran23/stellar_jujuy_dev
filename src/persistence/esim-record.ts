// Local eSIM metadata record (docs/citrus-mobile-spec.md v2 §7 R11): a
// file-backed map `iccid → row` at `data/esim-{network}.json` — the durable
// truth for provision reuse, the trip baseline, every top-up and the closing
// steps of the SessionCloser (R9).
//
// Design (mirrors `channel-record.ts` + `voucher-log.ts`):
// - Every write is the `.tmp` + `fsync` + `rename` sequence, so a crash mid-
//   write never corrupts the file a concurrent reader depends on.
// - `update(iccid, fn)` serializes writes per iccid with `createChannelMutex`
//   (the SAME primitive the agent uses for per-channel coalescing) — two
//   concurrent writers to one iccid never lose an update.
// - Reads re-read the file EVERY time (no in-memory cache): the usage loop,
//   FundingService and SessionCloser may live in different processes and must
//   observe each other's persistences.
// - Money stays bigint in memory (AC-R5) and is stored as a plain digit
//   string, exactly like `ChannelRecord.depositRaw` and the voucher log.

import fs from "node:fs";
import path from "node:path";
import { createChannelMutex, type ChannelMutex } from "../shared/mutex.ts";
import { sanitizeNetworkForFilename } from "../shared/stellar/network.ts";

export type EsimClosingStep =
  | "defund_solicitado"
  | "defund_liquidado"
  | "ultimo_vale_firmado"
  | "canal_cerrado";

export type EsimRecordStatus =
  | "provisioned"
  | "active"
  | "cut"
  | "defund_pending"
  | "idle"
  | "terminated";

export type EsimPendingFund = {
  /** Integer cents (USD) requested — the funding amount is never pooled. */
  amountCents: number;
  /** `wallet_balance_usd` (in cents) read JUST BEFORE `POST /fund`, so a
   * crash/timeout later reconciles against a known previous value (R5). */
  walletBeforeCents: number;
  requestedAt: string;
};

export type EsimDefund = {
  solicitedAt: string;
  /** From the 202 `defund` response (settles_in_minutes). */
  settlesInMinutes: number;
  /** `estimated_return_usd` of the 202, in micro-USD (cross-check, R9). */
  estimatedReturnMicroUsd: bigint;
  /** `returned_usd` of the `esim.defunded` webhook, micro-USD — settlement. */
  returnedMicroUsd: bigint | null;
  settledAt: string | null;
};

export type EsimRecordRow = {
  v: 1;
  iccid: string;
  userRef: string;
  channelId: string;
  status: EsimRecordStatus;
  /** Lifetime funded this trip, micro-USD (I2 invariant). */
  fundedMicroUsd: bigint;
  /** `total_data_charged_usd` read just before the first fund (R6/R9). */
  chargedBaselineMicroUsd: bigint;
  /** Persisted BEFORE `POST /fund`, cleared on confirmation; a crash leaves
   * it set so FundingService reconciles on restart instead of retrying (R5). */
  pendingFund: EsimPendingFund | null;
  defundPending: boolean;
  defund: EsimDefund | null;
  /** Non-null while the SessionCloser walk runs (R9); while set, the usage
   * loop and FundingService skip topUp/resume. */
  closing: { step: EsimClosingStep; startedAt: string } | null;
  /** Install data, kept so provision reuse returns the SAME record (R4). */
  lpaString: string;
  qrCode: string;
  directInstallUrl: string;
  createdAt: string;
  updatedAt: string;
};

type EsimDefundStorage = Omit<EsimDefund, "estimatedReturnMicroUsd" | "returnedMicroUsd"> & {
  estimatedReturnMicroUsd: string;
  returnedMicroUsd: string | null;
};

type EsimRecordStorage = Omit<EsimRecordRow, "fundedMicroUsd" | "chargedBaselineMicroUsd" | "defund"> & {
  fundedMicroUsd: string;
  chargedBaselineMicroUsd: string;
  defund: EsimDefundStorage | null;
  v: 1;
};

const BIGINT_KEYS = ["fundedMicroUsd", "chargedBaselineMicroUsd", "returnedMicroUsd", "estimatedReturnMicroUsd"] as const;

export function esimRecordPath(dataDir: string, network: string): string {
  return path.join(dataDir, `esim-${sanitizeNetworkForFilename(network)}.json`);
}

function toStorage(row: EsimRecordRow): EsimRecordStorage {
  const { fundedMicroUsd, chargedBaselineMicroUsd, defund, ...rest } = row;
  return {
    ...rest,
    fundedMicroUsd: fundedMicroUsd.toString(),
    chargedBaselineMicroUsd: chargedBaselineMicroUsd.toString(),
    // JSON.stringify cannot serialize a nested BigInt — the defund's money
    // fields are top-level-stringified here exactly like the row's own (AC-R5:
    // bigint in memory, plain digits on disk).
    defund:
      defund === null
        ? null
        : {
            solicitedAt: defund.solicitedAt,
            settlesInMinutes: defund.settlesInMinutes,
            estimatedReturnMicroUsd: defund.estimatedReturnMicroUsd.toString(),
            returnedMicroUsd: defund.returnedMicroUsd?.toString() ?? null,
            settledAt: defund.settledAt,
          },
  };
}

/** Rebuilds a row from parsed JSON, reviving bigint fields. Returns
 * `undefined` when the record does not belong to this store's shape. */
function parseRow(value: unknown, filePath: string): EsimRecordRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.iccid !== "string" || typeof record.channelId !== "string") {
    return undefined;
  }
  const revived: Record<string, unknown> = { ...record };
  for (const key of BIGINT_KEYS) {
    const raw = record[key];
    if (raw !== null && raw !== undefined && typeof raw === "string" && /^\d+$/.test(raw)) {
      revived[key] = BigInt(raw);
    }
  }
  // `returnedMicroUsd`/`estimatedReturnMicroUsd` live nested under `defund`;
  // revive them with the same digit-string rule as the top-level monies.
  const defund = record.defund as Record<string, unknown> | null | undefined;
  if (defund !== null && typeof defund === "object") {
    const revivedDefund: Record<string, unknown> = { ...defund };
    for (const key of BIGINT_KEYS) {
      const raw = defund[key];
      if (raw !== null && raw !== undefined && typeof raw === "string" && /^\d+$/.test(raw)) {
        revivedDefund[key] = BigInt(raw);
      }
    }
    revived.defund = revivedDefund;
  }
  return revived as unknown as EsimRecordRow;
}

function readMap(filePath: string): Map<string, EsimRecordRow> {
  const entries = new Map<string, EsimRecordRow>();
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return entries;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Corrupt file (crash mid-write) — treat as empty rather than crash the
    // process; the meta is evidence, never the source of truth.
    return entries;
  }
  if (!Array.isArray(parsed)) return entries;
  for (const item of parsed) {
    const row = parseRow(item, filePath);
    if (row !== undefined) entries.set(row.iccid, row);
  }
  return entries;
}

/** Atomic `.tmp` + `fsync` + `rename` (same discipline as channel-record.ts). */
function writeMap(filePath: string, rows: EsimRecordRow[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    const buffer = Buffer.from(JSON.stringify(rows.map(toStorage), null, 2), "utf8");
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

export type EsimStore = {
  filePath: string;
  /** Reads the WHOLE map fresh from disk (no cache — see module doc). */
  get(iccid: string): EsimRecordRow | undefined;
  getByUserRef(userRef: string): EsimRecordRow | undefined;
  list(): EsimRecordRow[];
  /** Serialized per-iccid (createChannelMutex); `mutate` receives the current
   * row from disk and returns the new one. Persists when undefined→non-
   * undefined too, so callers use it for both create and update. Awaited by
   * callers that persist state BEFORE a side effect (e.g. `pendingFund` before
   * `POST /fund`, R5) so the durable write happens first. */
  update(iccid: string, mutate: (row: EsimRecordRow | undefined) => EsimRecordRow): Promise<void>;
  mutex: ChannelMutex;
};

export function openEsimStore(filePath: string): EsimStore {
  const mutex = createChannelMutex();

  function snapshot(): Map<string, EsimRecordRow> {
    return readMap(filePath);
  }

  return {
    filePath,
    mutex,
    get(iccid) {
      return snapshot().get(iccid);
    },
    getByUserRef(userRef) {
      for (const row of snapshot().values()) {
        if (row.userRef === userRef) return row;
      }
      return undefined;
    },
    list() {
      return [...snapshot().values()];
    },
    update(iccid, mutate) {
      // Serialized per iccid: even when this store is shared by a usage loop,
      // a FundingService and a SessionCloser in the same process, concurrent
      // mutations of one iccid run one after another. Resolves when the
      // write is durable (fsync'd and renamed).
      return mutex.withChannelLock(`esim:${iccid}`, async () => {
        const map = snapshot();
        const current = map.get(iccid);
        const next = mutate(current);
        if (next === current) return;
        map.set(iccid, next);
        writeMap(filePath, [...map.values()]);
      });
    },
  };
}