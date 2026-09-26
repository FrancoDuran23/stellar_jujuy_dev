// Tests for CitrusWebhookHandler + signature verification (docs/citrus-mobile
// -spec.md v2 §7 R10). Persistence is real (temp files) — the store and the
// event log are the two things that are never mocked (design 4.7); only the
// provider's absence makes these "unit" (the handler never talks to Citrus).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CitrusWebhookHandler, verifyCitrusSignature, type WebhookHandleResult } from "./CitrusWebhookHandler.ts";
import { WebhookEventLog } from "../persistence/webhook-event.ts";
import { openEsimStore, type EsimRecordRow } from "../persistence/esim-record.ts";

const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Narrows WebhookHandleResult to its accepted variant (the handler only ever
 * answers `invalid_signature` when the caller skipped its own verification). */
function accept(result: WebhookHandleResult): WebhookHandleResult & { accepted: true } {
  assert.equal(result.accepted, true);
  return result as WebhookHandleResult & { accepted: true };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedRow(iccid: string, over: Partial<EsimRecordRow> = {}): EsimRecordRow {
  const now = new Date().toISOString();
  return {
    v: 1,
    iccid,
    userRef: `user_of_${iccid}`,
    channelId: "C-TEST-CHANNEL",
    status: "active",
    fundedMicroUsd: 5_000_000n,
    chargedBaselineMicroUsd: 1_000_000n,
    pendingFund: null,
    defundPending: false,
    defund: null,
    closing: null,
    lpaString: `LPA:1$test.smdp$${iccid}`,
    qrCode: `data:image/png;base64,qr_${iccid}`,
    directInstallUrl: `https://direct/${iccid}`,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function defundPendingRow(iccid: string): EsimRecordRow {
  return seedRow(iccid, {
    status: "defund_pending",
    defundPending: true,
    defund: {
      solicitedAt: new Date().toISOString(),
      settlesInMinutes: 15,
      estimatedReturnMicroUsd: 0n,
      returnedMicroUsd: null,
      settledAt: null,
    },
  });
}

test("verifyCitrusSignature: accepts the plain-hex and sha256= header forms", () => {
  const body = JSON.stringify({ id: "e1", event: "esim.defunded", created_at: "x", data: {} });
  const expected = sign(body);
  assert.equal(verifyCitrusSignature(Buffer.from(body), expected, SECRET), true);
  assert.equal(verifyCitrusSignature(Buffer.from(body), `sha256=${expected}`, SECRET), true);
  // Case-insensitive hex (Citrus may deliver upper-case).
  assert.equal(verifyCitrusSignature(Buffer.from(body), expected.toUpperCase(), SECRET), true);
});

test("verifyCitrusSignature: rejects wrong secret, tampered body, missing/malformed header", () => {
  const body = JSON.stringify({ id: "e1" });
  const expected = sign(body);
  assert.equal(verifyCitrusSignature(Buffer.from(body), expected, "whsec_other"), false);
  assert.equal(verifyCitrusSignature(Buffer.from(`${body} `), expected, SECRET), false);
  assert.equal(verifyCitrusSignature(Buffer.from(body), undefined, SECRET), false);
  assert.equal(verifyCitrusSignature(Buffer.from(body), "", SECRET), false);
  assert.equal(verifyCitrusSignature(Buffer.from(body), "sha256=nothex!", SECRET), false);
  assert.equal(verifyCitrusSignature(Buffer.from(body), "0123456789abcdef", SECRET), false);
});

function makeHarness() {
  const dir = tempDir("citrus-webhook-handler-");
  const storePath = path.join(dir, "esim.json");
  const logPath = path.join(dir, "events.jsonl");
  const store = openEsimStore(storePath);
  const log = WebhookEventLog.open(logPath);
  const stamped: Array<Record<string, unknown>> = [];
  const handler = new CitrusWebhookHandler({
    log,
    esimStore: store,
    logger: (line) => stamped.push(line as Record<string, unknown>),
  });
  return { dir, store, log, handler, stamped };
}

test("handle: malformed payload is logged and accepted (200-class), never throws", async () => {
  const { handler, store, stamped } = makeHarness();
  await store.update("FAKE-1", () => seedRow("FAKE-1"));
  const result = await handler.handle({ this_is_not: "an event", id: 42 });
  assert.deepEqual(result, { accepted: true, handled: "malformed", reason: "payload no parseable como evento Citrus" });
  assert.equal(stamped.some((l) => l.reason === "webhook_malformed"), true);
  // Store untouched.
  assert.equal(store.get("FAKE-1")!.defund, null);
});

test("handle esim.defunded: stamps settledAt + returnedMicroUsd on the existing defund", async () => {
  const { store, handler } = makeHarness();
  const iccid = "FUNDED-1";
  await store.update(iccid, () => defundPendingRow(iccid));
  const result = await handler.handle({
    id: "evt-defund-1",
    event: "esim.defunded",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { esim_id: iccid, returned_usd: 0.25 },
  });
  assert.deepEqual(result, { accepted: true, handled: "processed", event: "esim.defunded" });
  const row = store.get(iccid)!;
  assert.notEqual(row.defund!.settledAt, null);
  assert.equal(row.defund!.settledAt, row.updatedAt);
  assert.equal(row.defund!.returnedMicroUsd, 250_000n);
});

test("handle: a duplicate id is answered without re-processing (no second stamp)", async () => {
  const { store, handler } = makeHarness();
  const iccid = "DUP-1";
  await store.update(iccid, () => defundPendingRow(iccid));
  const event = {
    id: "evt-dup",
    event: "esim.defunded",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { esim_id: iccid, returned_usd: 0.25 },
  };
  const first = accept(await handler.handle(event));
  assert.equal(first.handled, "processed");
  const second = accept(await handler.handle({ ...event, data: { esim_id: iccid, returned_usd: 88 } }));
  assert.equal(second.handled, "duplicate");
  assert.equal(store.get(iccid)!.defund!.returnedMicroUsd, 250_000n);
});

test("handle esim.balance_depleted: marks the record cut without a provider call", async () => {
  const { store, handler } = makeHarness();
  const iccid = "CUT-1";
  await store.update(iccid, () => seedRow(iccid));
  const result = accept(await handler.handle({
    id: "evt-cut-1",
    event: "esim.balance_depleted",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { esim_id: iccid },
  }));
  assert.equal(result.handled, "processed");
  assert.equal(store.get(iccid)!.status, "cut");
});

test("handle: an unknown event type is logged and answered processed (R10)", async () => {
  const { store, handler, stamped } = makeHarness();
  const iccid = "IGN-1";
  await store.update(iccid, () => seedRow(iccid));
  const result = accept(await handler.handle({
    id: "evt-x",
    event: "esim.data_usage_threshold",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { esim_id: iccid },
  }));
  assert.equal(result.handled, "processed");
  assert.equal(store.get(iccid)!.status, "active");
  assert.equal(stamped.some((l) => l.reason === "webhook_event_deferred"), true);
});

test("replay: reprocesses recorded-but-unprocessed events at boot (crash between 200 and processing)", async () => {
  const { dir, log, store } = makeHarness();
  const iccid = "REPLAY-1";
  await store.update(iccid, () => defundPendingRow(iccid));
  // Simulate the crash: the event was persisted (pre-200) but never processed.
  log.record({
    id: "evt-replay-1",
    event: "esim.defunded",
    createdAt: "2026-09-24T10:00:00.000Z",
    payload: { id: "evt-replay-1", event: "esim.defunded", created_at: "2026-09-24T10:00:00.000Z", data: { esim_id: iccid, returned_usd: 0.5 } },
  });
  const logPath = log.path;
  const reopened = WebhookEventLog.open(logPath);
  const handler = new CitrusWebhookHandler({ log: reopened, esimStore: store, logger: () => {} });
  assert.equal(reopened.seen("evt-replay-1"), true);
  await handler.replay();
  const row = store.get(iccid)!;
  assert.notEqual(row.defund!.settledAt, null);
  assert.equal(row.defund!.returnedMicroUsd, 500_000n);
  // After replay the record is marked processed, so a second replay is a no-op.
  await handler.replay();
  assert.equal(store.get(iccid)!.defund!.returnedMicroUsd, 500_000n);
  void dir;
});

test("handle esim.defunded for an unknown/missing iccid warns but never throws", async () => {
  const { store, handler, stamped } = makeHarness();
  const unknown = accept(await handler.handle({
    id: "evt-unknown",
    event: "esim.defunded",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { esim_id: "NO-SUCH-ICCID", returned_usd: 0.25 },
  }));
  assert.equal(unknown.handled, "processed");
  assert.equal(stamped.some((l) => l.reason === "webhook_unknown_esim"), true);
  const missing = accept(await handler.handle({
    id: "evt-missing",
    event: "esim.defunded",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { returned_usd: 0.25 },
  }));
  assert.equal(missing.handled, "processed");
  assert.equal(store.list().length, 0);
});