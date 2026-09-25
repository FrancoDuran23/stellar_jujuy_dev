// Tests for SessionCloser (docs/citrus-mobile-spec.md v2 §7 R9): the persisted
// closing walk end-to-end against the FakeProvider + a real esim-record store
// (temp files). The meter is the real IntegratedMeterService with the
// in-memory voucher double; only the Stellar channel is faked (a ChannelBalancePort
// returning a fixed deposit + a closeChannel stub).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionCloser } from "./SessionCloser.ts";
import { FakeProvider } from "../providers/connectivity/FakeProvider.ts";
import { openEsimStore, type EsimRecordRow } from "../persistence/esim-record.ts";
import { IntegratedMeterService } from "../meter/meter-service.ts";
import { createInMemoryVoucherPort } from "../meter/voucher-port.ts";
import { createConnectivitySession } from "../models/ConnectivitySession.ts";
import { pricePerMibFromPerMbRaw } from "../shared/money.ts";
import type { CloseOutcome } from "../server/channel-service.ts";
import { CitrusWebhookHandler } from "./CitrusWebhookHandler.ts";
import { WebhookEventLog } from "../persistence/webhook-event.ts";

const PRICE_PER_MB_RAW = 25_000n;
const VOUCHER_PRICE_PER_MIB_RAW = pricePerMibFromPerMbRaw(PRICE_PER_MB_RAW);
const DEPOSIT_RAW = 50_000_000n;
const MARKUP_BPS = 15000;
const USDC_USD_RATE_BPS = 10000;
const CHANNEL = "C-CLOSE-TEST-01";

type Harness = {
  store: ReturnType<typeof openEsimStore>;
  provider: FakeProvider;
  closer: SessionCloser;
  closeCalls: () => number;
  setCloseOutcome: (outcome: CloseOutcome) => void;
  iccid: string;
  now: () => Date;
};

async function buildHarness(over: {
  closeOutcome?: CloseOutcome;
  stableWindowMs?: number;
  row?: Partial<EsimRecordRow>;
} = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-closer-"));
  let clock = 1_700_000_000_000;
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock += ms;
  };

  const store = openEsimStore(path.join(dir, "esim.json"));
  const provider = new FakeProvider(now);
  const iccid = (await provider.provisionEsim("user-1")).iccid;
  await provider.topUp(iccid, 500);
  provider.setChargedUsd(iccid, 1_000_000n);

  const baseRow: EsimRecordRow = {
    v: 1,
    iccid,
    userRef: "user-1",
    channelId: CHANNEL,
    status: "active",
    fundedMicroUsd: 5_000_000n,
    chargedBaselineMicroUsd: 1_000_000n,
    pendingFund: null,
    defundPending: false,
    defund: null,
    closing: null,
    lpaString: "LPA:1$fake.smdp$user-1",
    qrCode: "data:image/png;base64,qr",
    directInstallUrl: "https://direct",
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    ...over.row,
  };
  await store.update(iccid, () => baseRow);

  const meter = new IntegratedMeterService({
    session: createConnectivitySession({ id: "trip-1", userId: "user-1", iccid, channelId: CHANNEL }),
    provider,
    balancePort: { getChannelBalance: async () => DEPOSIT_RAW },
    voucherPort: createInMemoryVoucherPort({ depositRaw: DEPOSIT_RAW, seed: "session-closer-test" }),
    network: "stellar:testnet",
    voucherPricePerMibRaw: VOUCHER_PRICE_PER_MIB_RAW,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    logger: () => {},
    now,
  });

  let calls = 0;
  let currentOutcome: CloseOutcome =
    over.closeOutcome ?? { kind: "closed", txHash: "0xtx", settledRaw: 20_000n, refundedRaw: 1_000n };
  const closer = new SessionCloser({
    provider,
    esimStore: store,
    meter,
    closeChannel: async () => {
      calls += 1;
      return currentOutcome;
    },
    markupBps: MARKUP_BPS,
    usdcUsdRateBps: USDC_USD_RATE_BPS,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    stableWindowMs: over.stableWindowMs ?? 300_000,
    logger: () => {},
    now,
  });

  return {
    store,
    provider,
    closer,
    closeCalls: () => calls,
    setCloseOutcome: (outcome) => {
      currentOutcome = outcome;
    },
    iccid,
    now,
  };
}

test("caminata completa (fake + poll): defund → asentamiento → vale final → canal cerrado → idle", async () => {
  const h = await buildHarness({ stableWindowMs: 0 });

  const started = await h.closer.beginClose(h.iccid);
  assert.deepEqual(started, { started: true, reason: "ok" });
  assert.equal(h.store.get(h.iccid)!.closing!.step, "defund_solicitado");

  // 1) Solicitar el defund: el FakeProvider lo inicia y marcamos 202.
  const solicited = await h.closer.runOnce(h.iccid);
  assert.equal(solicited.step, "defund_liquidado");
  assert.equal(h.provider.sim(h.iccid).defundPending, true);
  assert.equal(h.store.get(h.iccid)!.closing!.step, "defund_liquidado");

  // 2) Espera: el wallet sigue fondado → no se asienta todavía.
  const waiting = await h.closer.runOnce(h.iccid);
  assert.equal(waiting.step, "defund_liquidado");
  assert.equal(waiting.settled, false);

  // 3) Citrus asienta el defund (wallet → 0) y hubo consumo final.
  h.provider.settleDefund(h.iccid);
  h.provider.setChargedUsd(h.iccid, 2_600_000n);
  h.store.get(h.iccid); // fresh read below
  const settled = await h.closer.runOnce(h.iccid);
  assert.equal(settled.step, "canal_cerrado"); // advanceAfterSettlement corre el vale final en el mismo paso
  assert.equal(h.store.get(h.iccid)!.closing!.step, "canal_cerrado");

  // 4) Cerrar el canal → done + estado idle con la próxima salida limpia.
  const done = await h.closer.runOnce(h.iccid);
  assert.equal(done.step, "done");
  assert.equal(h.closeCalls(), 1);
  const row = h.store.get(h.iccid)!;
  assert.equal(row.status, "idle");
  assert.equal(row.closing, null);
  assert.equal(row.defundPending, false);
  assert.equal(row.fundedMicroUsd, 0n);
  assert.equal(row.chargedBaselineMicroUsd, 0n);
  // El eSIM reaprovisionado reusa la misma fila (R4/D8); fake mantiene defund null.
  assert.equal(row.defund, null);
  assert.equal(row.channelId, CHANNEL);
});

test("la ruta webhook asienta por defund.settledAt y no vuelve a pedir el defund", async () => {
  const now = new Date().toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-closer-webhook-"));
  const h = await buildHarness({
    stableWindowMs: 0,
    // Como los perseguiría CitrusProvider.refundUnused: defund pendiente ya
    // persistido con su metadata, sin liquidar todavía.
    row: {
      status: "defund_pending",
      defundPending: true,
      defund: {
        solicitedAt: now,
        settlesInMinutes: 15,
        estimatedReturnMicroUsd: 0n,
        returnedMicroUsd: null,
        settledAt: null,
      },
    },
  });

  // El cierre reanuda en defund_liquidado (crash post-202), sin re-solicitar.
  const started = await h.closer.beginClose(h.iccid);
  assert.equal(started.started, true);
  assert.equal(h.store.get(h.iccid)!.closing!.step, "defund_liquidado");

  // El webhook esim.defunded estampa el asentamiento (ese es el rol del handler).
  const log = WebhookEventLog.open(path.join(dir, "events.jsonl"));
  const handler = new CitrusWebhookHandler({ log, esimStore: h.store, logger: () => {} });
  await handler.handle({
    id: "evt-def",
    event: "esim.defunded",
    created_at: now,
    data: { esim_id: h.iccid, returned_usd: 0.25 },
  });
  assert.notEqual(h.store.get(h.iccid)!.defund!.settledAt, null);

  // El Siguiente runOnce avanza por la ruta webhook (defund.settledAt != null).
  const after = await h.closer.runOnce(h.iccid);
  assert.equal(after.step, "canal_cerrado");

  const done = await h.closer.runOnce(h.iccid);
  assert.equal(done.step, "done");
  const row = h.store.get(h.iccid)!;
  assert.equal(row.status, "idle");
  // La auditoría conserva el registro del defund con su devolución.
  assert.equal(row.defund!.returnedMicroUsd, 250_000n);
  assert.notEqual(row.defund!.settledAt, null);
});

test("beginClose es idempotente: un cierre ya iniciado no se reinicia desde cero", async () => {
  const h = await buildHarness();
  const first = await h.closer.beginClose(h.iccid);
  assert.equal(first.started, true);
  const second = await h.closer.beginClose(h.iccid);
  assert.deepEqual(second, { started: false, reason: "already_closing" });
  // El marcador sigue en defund_solicitado (no se resetea al paso cero? sí, al primer paso).
  assert.equal(h.store.get(h.iccid)!.closing!.step, "defund_solicitado");
});

test("beginClose reanuda en defund_liquidado cuando el defund quedó pedido (crash) y no lo re-pide", async () => {
  const h = await buildHarness();
  // Crash tras refundUnused 202: defundPending persistido, fila sin closing.
  await h.store.update(h.iccid, (r) => ({ ...r!, defundPending: true }));
  const solicitedAtBefore = h.provider.sim(h.iccid).defundSolicitedAt;
  const started = await h.closer.beginClose(h.iccid);
  assert.equal(started.started, true);
  assert.equal(h.store.get(h.iccid)!.closing!.step, "defund_liquidado");

  // El paso de espera no vuelve a llamar refundUnused.
  await h.closer.runOnce(h.iccid);
  assert.equal(h.provider.sim(h.iccid).defundSolicitedAt, solicitedAtBefore);
});

test("runOnce sin fila o sin cierre en curso devuelve skipped", async () => {
  const h = await buildHarness();
  assert.deepEqual(await h.closer.runOnce("NO-SUCH"), { step: null, skipped: "no_row" });
  assert.deepEqual(await h.closer.runOnce(h.iccid), { step: null, skipped: "not_closing" });
});

test("un cierre de canal fallido mantiene el paso canal_cerrado para que el operador reintente", async () => {
  const h = await buildHarness({
    closeOutcome: { kind: "blocked", reason: "funder_trustline_missing", detail: "sin trustline" },
    row: { closing: { step: "canal_cerrado", startedAt: new Date().toISOString() } },
  });

  const first = await h.closer.runOnce(h.iccid);
  assert.equal(first.step, "canal_cerrado");
  assert.equal((first as { closeKind: string }).closeKind, "blocked");
  assert.equal(h.closeCalls(), 1);
  assert.equal(h.store.get(h.iccid)!.closing!.step, "canal_cerrado");

  const second = await h.closer.runOnce(h.iccid);
  assert.equal(second.step, "canal_cerrado");
  assert.equal(h.closeCalls(), 2);

  // El reintento con un resultado OK finaliza el camino.
  h.setCloseOutcome({ kind: "closed", txHash: "0xok", settledRaw: 20_000n, refundedRaw: 1_000n });
  const done = await h.closer.runOnce(h.iccid);
  assert.equal(done.step, "done");
  assert.equal(h.store.get(h.iccid)!.status, "idle");
});