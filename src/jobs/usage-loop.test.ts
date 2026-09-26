// Tests for UsageLoop (docs/citrus-mobile-spec.md v2 §7 R6/R7/R8): the unpaid
// cap (CITRUS_UNPAID_CAP_BPS) lifecycle — suspend when the unsigned accumulation
// exceeds its share of the deposit, resume when a SIGNED voucher covers it —
// plus the skips while a session is closing/defunding and the never-throw
// contract on provider errors. The meter is a controlled stub (its only
// contact surface with the loop is `processCumulative`'s voucher result); the
// provider is the FakeProvider with the real esim-record store.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageLoop } from "./usage-loop.ts";
import { FakeProvider } from "../providers/connectivity/FakeProvider.ts";
import { openEsimStore, type EsimRecordRow } from "../persistence/esim-record.ts";
import { equivalentBytes } from "../shared/usage-math.ts";
import { computeExpectedAmountRaw, pricePerMibFromPerMbRaw } from "../shared/money.ts";
import type { IntegratedMeterService } from "../meter/meter-service.ts";

const PRICE_PER_MB_RAW = 25_000n;
const VOUCHER_PRICE_PER_MIB_RAW = pricePerMibFromPerMbRaw(PRICE_PER_MB_RAW);
const DEPOSIT_RAW = 50_000_000n;
const MARKUP_BPS = 15000;
const USDC_USD_RATE_BPS = 10000;
const CHANNEL = "C-USAGE-01";
const CAP_BPS = 1000; // 10% del depósito

type UsageHarness = {
  store: ReturnType<typeof openEsimStore>;
  provider: FakeProvider;
  loop: UsageLoop;
  stamped: Array<Record<string, unknown>>;
  iccid: string;
  setVoucher: (v: VoucherStub) => void;
};

type VoucherStub = { kind: "signed"; envelope: { voucher: { cumulativeAmount: string } } } | { kind: "unsigned" };

async function buildHarness(over: { row?: Partial<EsimRecordRow>; chargedMicroUsd?: bigint } = {}): Promise<UsageHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-loop-"));
  const store = openEsimStore(path.join(dir, "esim.json"));
  const provider = new FakeProvider();
  const iccid = (await provider.provisionEsim("user-1")).iccid;
  if (over.chargedMicroUsd !== undefined) provider.setChargedUsd(iccid, over.chargedMicroUsd);

  const baseRow: EsimRecordRow = {
    v: 1,
    iccid,
    userRef: "user-1",
    channelId: CHANNEL,
    status: "active",
    fundedMicroUsd: 5_000_000n,
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

  let nextVoucher: VoucherStub = { kind: "signed", envelope: { voucher: { cumulativeAmount: "0" } } };
  const meter = {
    processCumulative: async () => ({ voucher: nextVoucher, actionApplied: null }),
  } as unknown as IntegratedMeterService;

  const stamped: Array<Record<string, unknown>> = [];
  const loop = new UsageLoop({
    provider,
    esimStore: store,
    meter,
    balancePort: { getChannelBalance: async () => DEPOSIT_RAW },
    markupBps: MARKUP_BPS,
    usdcUsdRateBps: USDC_USD_RATE_BPS,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    voucherPricePerMibRaw: VOUCHER_PRICE_PER_MIB_RAW,
    unpaidCapBps: CAP_BPS,
    pollIntervalMs: 5000,
    logger: (line) => stamped.push(line as Record<string, unknown>),
  });

  return {
    store,
    provider,
    loop,
    stamped,
    iccid,
    setVoucher: (v) => {
      nextVoucher = v;
    },
  };
}

test("cap de impago: sin voucher firmado que cubra la acumulación, el eSIM se suspende", async () => {
  const h = await buildHarness({ chargedMicroUsd: 1_000_000n });
  // 1 USD cargado → 600 MB equivalentes → expected ≫ 10% del depósito.
  const eqBytes = equivalentBytes(1_000_000n, MARKUP_BPS, USDC_USD_RATE_BPS, PRICE_PER_MB_RAW);
  const expected = computeExpectedAmountRaw(eqBytes, VOUCHER_PRICE_PER_MIB_RAW);
  const capRaw = (DEPOSIT_RAW * BigInt(CAP_BPS)) / 10_000n;
  assert.equal(expected > capRaw, true, `el escenario debe quedar sobre el cap: expected ${expected} > cap ${capRaw}`);

  h.setVoucher({ kind: "unsigned" });
  const first = await h.loop.runOnce(h.iccid);
  assert.equal(first.suspendedByUnpaid, true);
  assert.equal(h.provider.sim(h.iccid).status, "suspended");
  assert.equal(h.stamped.some((l) => l.reason === "unpaid_cap_exceeded_suspend"), true);
});

test("cap de impago: un voucher firmado que cubre la acumulación reanuda el eSIM", async () => {
  const h = await buildHarness({ chargedMicroUsd: 1_000_000n });
  const eqBytes = equivalentBytes(1_000_000n, MARKUP_BPS, USDC_USD_RATE_BPS, PRICE_PER_MB_RAW);
  const expected = computeExpectedAmountRaw(eqBytes, VOUCHER_PRICE_PER_MIB_RAW);

  h.setVoucher({ kind: "unsigned" });
  const suspended = await h.loop.runOnce(h.iccid);
  assert.equal(suspended.suspendedByUnpaid, true);
  assert.equal(h.provider.sim(h.iccid).status, "suspended");

  // Segundo tick sin cubrir: sigue suspendido, no re-suspende (transición única).
  const still = await h.loop.runOnce(h.iccid);
  assert.equal(still.suspendedByUnpaid, true);
  assert.equal(h.stamped.filter((l) => l.reason === "unpaid_cap_exceeded_suspend").length, 1);

  // La acumulación queda cubierta por un voucher firmado por el monto esperado.
  h.setVoucher({ kind: "signed", envelope: { voucher: { cumulativeAmount: expected.toString() } } });
  const resumed = await h.loop.runOnce(h.iccid);
  assert.equal(resumed.suspendedByUnpaid, false);
  assert.equal(h.provider.sim(h.iccid).status, "active");
  assert.equal(resumed.voucherCumulativeAmountRaw, expected);
  assert.equal(h.stamped.some((l) => l.reason === "unpaid_covered_resume"), true);
});

test("dentro del cap no se suspende (un voucher firmado mantiene el acumulado cubierto)", async () => {
  const h = await buildHarness({ chargedMicroUsd: 1_000_000n });
  const eqBytes = equivalentBytes(1_000_000n, MARKUP_BPS, USDC_USD_RATE_BPS, PRICE_PER_MB_RAW);
  const expected = computeExpectedAmountRaw(eqBytes, VOUCHER_PRICE_PER_MIB_RAW);
  h.setVoucher({ kind: "signed", envelope: { voucher: { cumulativeAmount: expected.toString() } } });
  const ok = await h.loop.runOnce(h.iccid);
  assert.equal(ok.suspendedByUnpaid, false);
  assert.equal(h.provider.sim(h.iccid).status, "active");
  assert.equal(ok.equivalentBytes, 600_000_000n);
});

test("skips: fila en closing, defund pendiente o sin fila no tocan ni al proveedor ni al meter", async () => {
  const h = await buildHarness();
  h.setVoucher({ kind: "unsigned" });

  await h.store.update(h.iccid, (r) => ({ ...r!, closing: { step: "defund_solicitado", startedAt: new Date().toISOString() } }));
  const closing = await h.loop.runOnce(h.iccid);
  assert.equal(closing.skipped, "closing");
  assert.equal(closing.equivalentBytes, 0n);

  await h.store.update(h.iccid, (r) => ({ ...r!, closing: null, defundPending: true }));
  const defunding = await h.loop.runOnce(h.iccid);
  assert.equal(defunding.skipped, "defund_pending");

  const noRow = await h.loop.runOnce("no-such-iccid");
  assert.equal(noRow.skipped, "no_row");
});

test("nunca lanza: un error de red en getUsage se loguea y el tick devuelve ceros", async () => {
  const h = await buildHarness();
  const flaky = new FakeProvider();
  const iccid = (await flaky.provisionEsim("flaky-1")).iccid;
  await h.store.update(iccid, () => ({
    v: 1,
    iccid,
    userRef: "flaky-1",
    channelId: "C-FLAKY",
    status: "active",
    fundedMicroUsd: 5_000_000n,
    chargedBaselineMicroUsd: 0n,
    pendingFund: null,
    defundPending: false,
    defund: null,
    closing: null,
    lpaString: "LPA:1$fake.smdp$flaky-1",
    qrCode: "data:image/png;base64,qr",
    directInstallUrl: "https://direct",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  flaky.getUsage = async () => {
    throw new Error("red caída");
  };
  const loop = new UsageLoop({
    provider: flaky,
    esimStore: h.store,
    meter: { processCumulative: async () => ({ voucher: { kind: "unsigned" }, actionApplied: null }) } as unknown as IntegratedMeterService,
    balancePort: { getChannelBalance: async () => DEPOSIT_RAW },
    markupBps: MARKUP_BPS,
    usdcUsdRateBps: USDC_USD_RATE_BPS,
    pricePerMbRaw: PRICE_PER_MB_RAW,
    voucherPricePerMibRaw: VOUCHER_PRICE_PER_MIB_RAW,
    unpaidCapBps: CAP_BPS,
    pollIntervalMs: 5000,
    logger: (line) => h.stamped.push(line as Record<string, unknown>),
  });
  const result = await loop.runOnce(iccid);
  assert.deepEqual(result, { skipped: null, chargedMicroUsd: 0n, equivalentBytes: 0n, voucherCumulativeAmountRaw: 0n, suspendedByUnpaid: false });
  assert.equal(h.stamped.some((l) => l.reason === "usage_reading_failed"), true);
});