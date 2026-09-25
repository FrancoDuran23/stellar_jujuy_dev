// CitrusWebhookHandler (docs/citrus-mobile-spec.md v2 §7 R10): verifies the
// HMAC-SHA256 signature of `POST /citrus/webhooks` events and applies the two
// treated events to esim-record.
//
// Order (R10, non-negotiable): persist the event to the JSONL BEFORE the host
// answers 200, process it after. At boot the host replays `log.unprocessed()`,
// so a crash between the 200 and the processing is replayed, and the dedup set
// rebuilt by id means a re-delivered event never processes twice.
//
// Events:
// - `esim.defunded`  → stamps `defund.settledAt`/`returnedMicroUsd`; the
//   SessionCloser sees it on its next run and proceeds (R9 step 2 webhook
//   path).
// - `esim.balance_depleted` → marks the record `cut` (diagnosis); the wallet
//   already cut data, no provider call needed.
// - anything else → logged and answered 200 (R10: the rest is deferred).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEventLog, WebhookEventRecord } from "../persistence/webhook-event.ts";
import type { EsimStore } from "../persistence/esim-record.ts";
import { usdToMicroUsd } from "../providers/connectivity/CitrusProvider.ts";

const SIGNATURE_RE = /^(?:sha256=)?([0-9a-fA-F]{64})$/;

/**
 * Constant-time HMAC-SHA256 verification of the RAW body against
 * `X-Citrus-Signature`, accepting hex with or without the `sha256=` prefix
 * (Citrus does not document the exact format — spec v2 §12.4). `undefined`
 * or a malformed header is invalid, never thrown for.
 */
export function verifyCitrusSignature(
  body: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || signatureHeader === "" || secret === "") return false;
  const match = SIGNATURE_RE.exec(signatureHeader.trim());
  if (match === null) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const received = Buffer.from(match[1].toLowerCase(), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export type WebhookHandleResult =
  | { accepted: true; handled: "processed" | "duplicate" | "malformed"; event?: string; reason?: string }
  | { accepted: false; reason: "invalid_signature" };

export type CitrusWebhookHandlerOptions = {
  log: WebhookEventLog;
  esimStore: EsimStore;
  logger?: (line: unknown) => void;
  now?: () => Date;
};

export class CitrusWebhookHandler {
  private readonly log: WebhookEventLog;
  private readonly esimStore: EsimStore;
  private readonly logger: (line: unknown) => void;
  private readonly now: () => Date;

  constructor(options: CitrusWebhookHandlerOptions) {
    this.log = options.log;
    this.esimStore = options.esimStore;
    this.logger = options.logger ?? ((line) => console.log(JSON.stringify(line)));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Dedup + persist(then 200) + process. Never throws: a malformed payload is
   * logged and accepted (200) so Citrus never redelivers it forever — the
   * append-only log keeps the debugging trail. Async because the esim-record
   * write is a serialized file mutation that the host awaits BEFORE answering,
   * keeping the R10 ordering observable (record then 200).
   */
  async handle(payload: unknown): Promise<WebhookHandleResult> {
    const parsed = parseWebhookPayload(payload);
    if (parsed === null) {
      this.logger({ level: "warn", reason: "webhook_malformed", payload: safeStringify(payload) });
      return { accepted: true, handled: "malformed", reason: "payload no parseable como evento Citrus" };
    }
    if (this.log.seen(parsed.id)) {
      return { accepted: true, handled: "duplicate", event: parsed.event };
    }
    const record = this.log.record({
      id: parsed.id,
      event: parsed.event,
      createdAt: parsed.createdAt,
      payload,
    });
    await this.process(record);
    return { accepted: true, handled: "processed", event: parsed.event };
  }

  /** Replays every recorded-but-unprocessed event at boot (R10). Never throws:
   * a failing event is logged, marked processed (it stays in the dedup set)
   * and skipped, so a poison event cannot wedge the boot loop forever. */
  async replay(): Promise<void> {
    for (const record of this.log.unprocessed()) {
      await this.process(record);
    }
  }

  private async process(record: WebhookEventRecord): Promise<void> {
    try {
      switch (record.event) {
        case "esim.defunded":
          await this.onDefunded(record);
          break;
        case "esim.balance_depleted":
          await this.onBalanceDepleted(record);
          break;
        default:
          this.logger({
            level: "info",
            reason: "webhook_event_deferred",
            id: record.id,
            event: record.event,
            receivedAt: record.receivedAt,
          });
      }
    } catch (error) {
      this.logger({
        level: "error",
        reason: "webhook_processing_failed",
        id: record.id,
        event: record.event,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.log.markProcessed(record.id);
    }
  }

  private iccidOf(record: WebhookEventRecord): string | undefined {
    return esimIdFromPayload(record.payload);
  }

  private async onDefunded(record: WebhookEventRecord): Promise<void> {
    const iccid = this.iccidOf(record);
    if (iccid === undefined) {
      this.logger({ level: "warn", reason: "webhook_no_iccid", id: record.id, event: record.event });
      return;
    }
    const now = this.now().toISOString();
    const returnedUsd = returnedUsdFromPayload(record.payload);
    const returnedMicroUsd = returnedUsd !== undefined ? usdToMicroUsd(returnedUsd) : null;
    const row = this.esimStore.get(iccid);
    if (row === undefined) {
      this.logger({ level: "warn", reason: "webhook_unknown_esim", id: record.id, iccid });
      return;
    }
    await this.esimStore.update(iccid, (current) => {
      const base = current ?? row;
      return {
        ...base,
        defund:
          base.defund !== null
            ? {
                ...base.defund,
                settledAt: base.defund.settledAt ?? now,
                ...(returnedMicroUsd !== null ? { returnedMicroUsd } : {}),
              }
            : {
                solicitedAt: now,
                settlesInMinutes: 15,
                estimatedReturnMicroUsd: 0n,
                returnedMicroUsd,
                settledAt: now,
              },
        updatedAt: now,
      };
    });
    this.logger({
      level: "info",
      reason: "esim_defunded",
      iccid,
      returnedMicroUsd: returnedMicroUsd?.toString() ?? null,
      id: record.id,
    });
  }

  private async onBalanceDepleted(record: WebhookEventRecord): Promise<void> {
    const iccid = this.iccidOf(record);
    if (iccid === undefined) return;
    const now = this.now().toISOString();
    const row = this.esimStore.get(iccid);
    if (row === undefined) return;
    await this.esimStore.update(iccid, (current) => ({
      ...(current ?? row),
      status: "cut",
      updatedAt: now,
    }));
    this.logger({ level: "warn", reason: "esim_balance_depleted", iccid, id: record.id });
  }
}

type ParsedWebhook = {
  id: string;
  event: string;
  createdAt: string;
};

function parseWebhookPayload(payload: unknown): ParsedWebhook | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id !== "" ? record.id : undefined;
  const event = typeof record.event === "string" && record.event !== "" ? record.event : undefined;
  const createdAt = typeof record.created_at === "string" && record.created_at !== "" ? record.created_at : undefined;
  if (id === undefined || event === undefined || createdAt === undefined) return null;
  return { id, event, createdAt };
}

/** Citrus event payload shape is not fully documented; accept the common
 * placements (`data.esim_id` / `data.iccid` / top-level). */
function esimIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const candidate = data?.esim_id ?? data?.iccid ?? record.esim_id ?? record.iccid;
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

/** `returned_usd` from the `esim.defunded` event (USD number, like the API). */
function returnedUsdFromPayload(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const candidate = data?.returned_usd ?? data?.returned ?? record.returned_usd;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}