// Webhook event log (docs/citrus-mobile-spec.md v2 §7 R10): the durable record
// of every `POST /citrus/webhooks` event BEFORE the 200 is answered, plus the
// dedup set rebuilt by `id` at boot.
//
// Contract:
// - `record(event)` appends a JSONL line and fsyncs before returning — the
//   webhook handler persists the event, replies 200, and only then processes.
// - `markProcessed(id)` compacts the file, stamping `processedAt`. The volume
//   is tiny (one line per Citrus event), so a full rewrite is the simplest
//   reliable way to make the marker durable (crash between 200 and processing
//   must still replay the event, R10: "reprocesar los no marcados processed_at").
// - `open()` replays the file: `seen` has every id (dedup), `unprocessed()`
//   yields the records whose `processedAt` is null (reprocess at boot).

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export type WebhookEventRecord = {
  v: 1;
  id: string;
  event: string;
  /** `created_at` as Citrus delivered it. */
  createdAt: string;
  /** When the server received it. */
  receivedAt: string;
  processedAt: string | null;
  payload: unknown;
};

const recordSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  event: z.string().min(1),
  createdAt: z.string().min(1),
  receivedAt: z.string().min(1),
  processedAt: z.string().nullable(),
  payload: z.unknown(),
});

function parseLine(line: string): WebhookEventRecord | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = recordSchema.safeParse(candidate);
  return result.success ? (result.data as WebhookEventRecord) : undefined;
}

export class WebhookEventLog {
  private readonly filePath: string;
  private readonly recordsById: Map<string, WebhookEventRecord>;

  private constructor(filePath: string, recordsById: Map<string, WebhookEventRecord>) {
    this.filePath = filePath;
    this.recordsById = recordsById;
  }

  /** Opens (creating if needed) the log, replaying it to rebuild the dedup set
   * and the unprocessed backlog (R10). A corrupt/truncated trailing line is
   * discarded with a warning (append-only best effort, same stance as the
   * voucher log); a corrupt middle line is tolerated by keeping the valid
   * records before it — the dedup set is rebuilt from the valid ones. */
  static open(filePath: string): WebhookEventLog {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const recordsById = new Map<string, WebhookEventRecord>();
    let content = "";
    try {
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf8");
      }
    } catch {
      return new WebhookEventLog(filePath, recordsById);
    }
    for (const line of content.split("\n")) {
      if (line === "") continue;
      const record = parseLine(line);
      if (record === undefined) continue;
      recordsById.set(record.id, record);
    }
    return new WebhookEventLog(filePath, recordsById);
  }

  /** True when this event id was already recorded (dedup: the handler answers
   * 200 without re-processing a replay). */
  seen(id: string): boolean {
    return this.recordsById.has(id);
  }

  /** The recorded record for `id`, or undefined. */
  get(id: string): WebhookEventRecord | undefined {
    return this.recordsById.get(id);
  }

  /** Pending re-processing at boot: recorded but never marked processed. */
  unprocessed(): WebhookEventRecord[] {
    return [...this.recordsById.values()].filter((record) => record.processedAt === null);
  }

  /**
   * Persists an event line + fsync, then updates the in-memory dedup set.
   * MUST be called before the handler answers 200 (R10).
   */
  record(input: {
    id: string;
    event: string;
    createdAt: string;
    payload: unknown;
    receivedAt?: string;
  }): WebhookEventRecord {
    const record: WebhookEventRecord = {
      v: 1,
      id: input.id,
      event: input.event,
      createdAt: input.createdAt,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      processedAt: null,
      payload: input.payload,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    const fd = fs.openSync(this.filePath, "a");
    try {
      let written = 0;
      while (written < buffer.length) {
        written += fs.writeSync(fd, buffer, written, buffer.length - written);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.recordsById.set(record.id, record);
    return record;
  }

  /** Marks an event processed, compacting the file (`.tmp` + fsync + rename).
   * Synchronous: webhook volume is one line per event, and the file must be
   * durable before the handler returns. */
  markProcessed(id: string): void {
    const current = this.recordsById.get(id);
    if (current !== undefined && current.processedAt !== null) return;
    const updated = current === undefined
      ? undefined
      : { ...current, processedAt: new Date().toISOString() };
    if (updated !== undefined) {
      this.recordsById.set(id, updated);
    }
    const rows = [...this.recordsById.values()];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      let content = "";
      for (const row of rows) {
        content += `${JSON.stringify(row)}\n`;
      }
      const buffer = Buffer.from(content, "utf8");
      let written = 0;
      while (written < buffer.length) {
        written += fs.writeSync(fd, buffer, written, buffer.length - written);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  get path(): string {
    return this.filePath;
  }
}

export function webhookEventPath(dataDir: string, network: string): string {
  return path.join(dataDir, `citrus-webhook-events-${network.replace(":", "-")}.jsonl`);
}