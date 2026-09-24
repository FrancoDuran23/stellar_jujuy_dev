// Tests for FundingService (docs/citrus-mobile-spec.md v2 §7 R5): the single
// top-up to the ceiling `maxWalletCents` (I2), the crash/timeout RECONCILIATION
// against `pendingFund` + the wallet instead of a blind retry, and the policy:
// a definitive 400/401/404/409 rejection clears the durable intent and
// rethrows, while a retryable/timeout rejection KEEPS `pendingFund` as the
// durable record for the next run.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FundingService, MICRO_USD_PER_CENT } from "./FundingService.ts";
import { FakeProvider } from "../providers/connectivity/FakeProvider.ts";
import { openEsimStore, type EsimRecordRow } from "../persistence/esim-record.ts";
import { maxWalletCents } from "../shared/usage-math.ts";
import { CitrusApiError } from "../shared/citrus-errors.ts";

const DEPOSIT_RAW = 50_000_000n;
const MARKUP_BPS = 15000;
const USDC_USD_RATE_BPS = 10000;
const CHANNEL = "C-FUND-01";
const MAX_CENTS = maxWalletCents(DEPOSIT_RAW, USDC_USD_RATE_BPS, MARKUP_BPS); // 333

type FundHarness = {
  store: ReturnType<typeof openEsimStore>;
  provider: FakeProvider;
  service: FundingService;
  stamped: Array<Record<string, unknown>>;
  iccid: string;
};

async function buildHarness(over: { row?: Partial<EsimRecordRow>; topUpError?: unknown; walletCents?: number } = {}): Promise<FundHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "funding-service-"));
  const store = openEsimStore(path.join(dir, "esim.json"));
  const provider = new FakeProvider();
  const iccid = (await provider.provisionEsim("user-1")).iccid;
  if (over.topUpError !== undefined) {
    provider.topUp = async (_iccid: string, _amountCents: number): Promise<void> => {
      throw over.topUpError;
    };
  }
  if (over.walletCents !== undefined) {
    await provider.topUp(iccid, over.walletCents);
  }
  const baseRow: EsimRecordRow = {
    v: 1,
    iccid,
    userRef: "user-1",
    channelId: CHANNEL,
    status: "active",
    fundedMicroUsd: 0n,
    chargedBaselineMicroUsd: 0n,
    pendingFund: null,
    defundPending: false,
    defund: null,
    closing: null,
    lpaString: "LPA:1$fake.smdp$user-1",
    qrCode: "data:image/png;base64,qr",
    directInstallUrl: "https://direct",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over.row,
  };
  await store.update(iccid, () => baseRow);

  const stamped: Array<Record<string, unknown>> = [];
  const service = new FundingService({
    provider,
    esimStore: store,
    balancePort: { getChannelBalance: async () => DEPOSIT_RAW },
    markupsBps: MARKUP_BPS,
    usdcUsdRateBps: USDC_USD_RATE_BPS,
    logger: (line) => stamped.push(line as Record<string, unknown>),
  });
  return { store, provider, service, stamped, iccid };
}

test("sin fila → no_row; con closing/defund/terminated → no toca el proveedor", async () => {
  const h = await buildHarness();
  assert.deepEqual(await h.service.ensureFunded({ iccid: "no-row", userRef: "x", channelId: CHANNEL }), { funded: false, reason: "no_row" });

  await h.store.update(h.iccid, (r) => ({ ...r!, closing: { step: "defund_solicitado", startedAt: new Date().toISOString() } }));
  assert.deepEqual(await h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL }), { funded: false, reason: "closing" });

  await h.store.update(h.iccid, (r) => ({ ...r!, closing: null, defundPending: true }));
  assert.deepEqual(await h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL }), { funded: false, reason: "defund_pending" });
  assert.equal(h.provider.list()[0]!.fundingRequests.length, 0);
});

test("ya financiado al techo → already_funded, sin topUp", async () => {
  const h = await buildHarness({ row: { fundedMicroUsd: BigInt(MAX_CENTS) * MICRO_USD_PER_CENT } });
  const result = await h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL });
  assert.deepEqual(result, { funded: false, reason: "already_funded" });
  assert.equal(h.provider.sim(h.iccid).fundingRequests.length, 0);
});

test("financia el hueco al techo (gap completo, I2) y lo confirma", async () => {
  const h = await buildHarness();
  const result = await h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL });
  assert.deepEqual(result, { funded: true, amountCents: MAX_CENTS });
  const row = h.store.get(h.iccid)!;
  assert.equal(row.pendingFund, null);
  assert.equal(row.fundedMicroUsd, BigInt(MAX_CENTS) * MICRO_USD_PER_CENT);
  assert.equal(h.provider.sim(h.iccid).fundingRequests.length, 1);
  assert.equal(h.stamped.some((l) => l.reason === "wallet_funded" && l.source === "confirmed"), true);
});

test("reconciliación R5: un pendingFund que ATERRIZÓ se acredita sin volver a fundir", async () => {
  // Crash tras POST /fund pero antes de confirmar: la wallet ya creció.
  const h = await buildHarness({
    walletCents: MAX_CENTS,
    row: {
      pendingFund: { amountCents: MAX_CENTS, walletBeforeCents: 0, requestedAt: "2026-09-24T10:00:00.000Z" },
    },
  });
  const result = await h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL });
  assert.deepEqual(result, { funded: false, reason: "already_funded" }); // el gap quedó cubierto por la reconciliación
  const row = h.store.get(h.iccid)!;
  assert.equal(row.pendingFund, null);
  assert.equal(row.fundedMicroUsd, BigInt(MAX_CENTS) * MICRO_USD_PER_CENT);
  assert.equal(h.provider.sim(h.iccid).fundingRequests.length, 1); // el topUp que ya había sucedido
  assert.equal(h.stamped.some((l) => l.reason === "wallet_funded" && l.source === "reconciled"), true);
});

test("reconciliación R5: un pendingFund que NO aterrizó se descarta y se funde fresco", async () => {
  const h = await buildHarness({
    row: { pendingFund: { amountCents: MAX_CENTS, walletBeforeCents: 0, requestedAt: "2026-09-24T10:00:00.000Z" } },
  });
  const result = await h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL });
  assert.deepEqual(result, { funded: true, amountCents: MAX_CENTS });
  const row = h.store.get(h.iccid)!;
  assert.equal(row.pendingFund, null);
  assert.equal(row.fundedMicroUsd, BigInt(MAX_CENTS) * MICRO_USD_PER_CENT);
  assert.equal(h.stamped.some((l) => l.reason === "fund_intent_dropped"), true);
  assert.equal(h.provider.sim(h.iccid).fundingRequests.length, 1); // el intento fresco
});

test("un rechazo definitivo (400/401/404/409) limpia el intento durable y relanza", async () => {
  const h = await buildHarness({
    topUpError: new CitrusApiError(409, "CONFLICT", "la wallet tiene un defund pendiente", { retryable: false }),
  });
  await assert.rejects(h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL }));
  const row = h.store.get(h.iccid)!;
  assert.equal(row.pendingFund, null);
  assert.equal(row.fundedMicroUsd, 0n);
});

test("un rechazo reintentable/timeout NO limpia el pendingFund (queda para reconciliar en el próximo run)", async () => {
  const h = await buildHarness({
    topUpError: new CitrusApiError(0, "REQUEST_TIMEOUT", "el fund se colgó", { retryable: true }),
  });
  await assert.rejects(h.service.ensureFunded({ iccid: h.iccid, userRef: "user-1", channelId: CHANNEL }));
  const row = h.store.get(h.iccid)!;
  assert.notEqual(row.pendingFund, null);
  assert.deepEqual(row.pendingFund!.amountCents, MAX_CENTS);
});