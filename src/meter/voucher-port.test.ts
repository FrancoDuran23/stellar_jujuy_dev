import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  VoucherTransportError,
  buildMessage1,
  createHttpVoucherPort,
  createInMemoryVoucherPort,
  withVoucherRetry,
  type VoucherPort,
} from "./voucher-port.ts";
import { buildUnsigned, message1Schema, type Message1, type Message2 } from "../shared/messages.ts";
import { VoucherLog } from "../persistence/voucher-log.ts";
import { createFakeSigner } from "../agent/signer.ts";
import { createStaticDepositPort, createVoucherService, createVouchersRoute } from "../agent/routes/vouchers.ts";

const NETWORK = "stellar:testnet" as const;
const CHANNEL = `C${"A".repeat(55)}`;
const GATEWAY_TOKEN = "meter-test-gateway-token";
const PRICE_PER_MIB_RAW = 1_048_576n; // 1 raw por byte: montos fáciles de leer

function m1(cumulativeBytes: number, overrides: Partial<Message1> = {}): Message1 {
  return {
    ...buildMessage1({
      sessionId: "sess_1",
      channel: CHANNEL,
      network: NETWORK,
      cumulativeBytes,
      pricePerMibRaw: PRICE_PER_MIB_RAW,
      meterReadingId: `mr_${cumulativeBytes}`,
      observedAt: new Date("2026-09-23T12:00:00.000Z"),
    }),
    ...overrides,
  };
}

function unsigned(reason: Parameters<typeof buildUnsigned>[0], meterReadingId = "mr_1"): Message2 {
  return buildUnsigned(reason, {
    sessionId: "sess_1",
    channel: CHANNEL,
    remaining: "0",
    meterReadingId,
    detail: `test ${reason}`,
  }).body;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noSleep = async () => {};

// --- buildMessage1 ----------------------------------------------------------

test("buildMessage1: arma un M1 válido con el monto de la función compartida (ceilDiv por MiB)", () => {
  const message = buildMessage1({
    sessionId: "sess_1",
    channel: CHANNEL,
    network: NETWORK,
    cumulativeBytes: 1_048_577,
    pricePerMibRaw: 10_000n,
    meterReadingId: "mr_1",
    observedAt: new Date("2026-09-23T12:00:00.000Z"),
  });
  assert.equal(message1Schema.safeParse(message).success, true);
  // 1 MiB + 1 byte a 10_000 raw/MiB → ceil = 10_001 (AC-R2)
  assert.equal(message.cumulativeAmount, "10001");
  assert.equal(message.channel, CHANNEL);
  assert.equal(message.asset, "USDC");
  assert.equal(message.observedAt, "2026-09-23T12:00:00.000Z");
});

// --- HTTP contra la ruta real del agente -------------------------------------

async function withRealAgentRoute(
  depositRaw: bigint,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meter-voucher-port-test-"));
  const opened = VoucherLog.open(path.join(dir, "vouchers-agent-testnet.jsonl"));
  if (opened.status !== "ok") throw new Error("no se pudo abrir el voucher log de test");
  const service = createVoucherService({
    voucherLog: opened.log,
    signer: createFakeSigner(),
    depositPort: createStaticDepositPort(depositRaw),
    network: NETWORK,
    pricePerMibRaw: PRICE_PER_MIB_RAW,
    maxDeltaPerRequestRaw: 100_000_000n,
    emit: () => {},
  });
  const app = express();
  app.use(express.json());
  app.post("/vouchers", createVouchersRoute({ gatewayToken: GATEWAY_TOKEN, service, channel: CHANNEL }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}/vouchers`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("createHttpVoucherPort: contra la ruta real firma, reusa por monto igual y rechaza por agotamiento", async () => {
  await withRealAgentRoute(3_000_000n, async (url) => {
    const port = createHttpVoucherPort({ url, gatewayToken: GATEWAY_TOKEN });

    const first = await port.requestVoucher(m1(1_000_000));
    assert.equal(first.status, "signed");
    if (first.status !== "signed") return;
    assert.equal(first.reused, false);
    assert.equal(first.voucher.cumulativeAmount, "1000000");
    assert.equal(first.remaining, "2000000");

    // Misma lectura acumulada (reintento del gateway) → idempotente (VE-R9)
    const again = await port.requestVoucher(m1(1_000_000, { meterReadingId: "mr_retry" }));
    assert.equal(again.status, "signed");
    if (again.status !== "signed") return;
    assert.equal(again.reused, true);
    assert.equal(again.voucher.signature, first.voucher.signature);

    // Por encima del depósito → channel_exhausted, no reintentable (200)
    const exhausted = await port.requestVoucher(m1(4_000_000));
    assert.equal(exhausted.status, "unsigned");
    if (exhausted.status !== "unsigned") return;
    assert.equal(exhausted.reason, "channel_exhausted");
    assert.equal(exhausted.retryable, false);
  });
});

test("createHttpVoucherPort: token incorrecto → VoucherTransportError 401 no reintentable", async () => {
  await withRealAgentRoute(3_000_000n, async (url) => {
    const port = createHttpVoucherPort({ url, gatewayToken: "token-equivocado" });
    await assert.rejects(
      () => port.requestVoucher(m1(1_000_000)),
      (error: unknown) =>
        error instanceof VoucherTransportError && error.httpStatus === 401 && error.retryable === false,
    );
  });
});

// --- HTTP con fetch inyectado ------------------------------------------------

test("createHttpVoucherPort: envía POST con X-Gateway-Token y el M1 como JSON", async () => {
  let captured: { url: string; init: RequestInit | undefined } | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    captured = { url: String(input), init };
    return jsonResponse(503, unsigned("upstream_unavailable"));
  };
  const port = createHttpVoucherPort({ url: "http://agent.test/vouchers", gatewayToken: GATEWAY_TOKEN, fetch: fakeFetch });
  const reading = m1(2_000_000);
  const result = await port.requestVoucher(reading);

  assert.ok(captured);
  assert.equal(captured.url, "http://agent.test/vouchers");
  assert.equal(captured.init?.method, "POST");
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers["x-gateway-token"], GATEWAY_TOKEN);
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), reading);

  // 503 con sobre M2 válido: se devuelve tal cual, retryable explícito
  assert.equal(result.status, "unsigned");
  if (result.status !== "unsigned") return;
  assert.equal(result.reason, "upstream_unavailable");
  assert.equal(result.retryable, true);
});

test("createHttpVoucherPort: mapea respuestas no-M2 a VoucherTransportError con retryable correcto", async () => {
  const cases: Array<{ name: string; response: () => Response; retryable: boolean; status?: number }> = [
    { name: "400 schema", response: () => jsonResponse(400, { error: "invalid message1 body" }), retryable: false, status: 400 },
    { name: "401 token", response: () => jsonResponse(401, { error: "missing" }), retryable: false, status: 401 },
    { name: "404", response: () => jsonResponse(404, { error: "not found" }), retryable: false, status: 404 },
    { name: "200 sin M2", response: () => jsonResponse(200, { ok: true }), retryable: false, status: 200 },
    { name: "503 sin M2 (proxy)", response: () => new Response("Service Unavailable", { status: 503 }), retryable: true, status: 503 },
    { name: "502 gateway", response: () => new Response("Bad Gateway", { status: 502 }), retryable: true, status: 502 },
  ];
  for (const c of cases) {
    const port = createHttpVoucherPort({
      url: "http://agent.test/vouchers",
      gatewayToken: GATEWAY_TOKEN,
      fetch: async () => c.response(),
    });
    await assert.rejects(
      () => port.requestVoucher(m1(1_000_000)),
      (error: unknown) =>
        error instanceof VoucherTransportError && error.retryable === c.retryable && error.httpStatus === c.status,
      c.name,
    );
  }
});

test("createHttpVoucherPort: error de red → VoucherTransportError reintentable", async () => {
  const port = createHttpVoucherPort({
    url: "http://agent.test/vouchers",
    gatewayToken: GATEWAY_TOKEN,
    fetch: async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => port.requestVoucher(m1(1_000_000)),
    (error: unknown) => error instanceof VoucherTransportError && error.retryable === true,
  );
});

test("createHttpVoucherPort: un M1 inválido falla antes de salir a la red (no reintentable)", async () => {
  let fetchCalls = 0;
  const port = createHttpVoucherPort({
    url: "http://agent.test/vouchers",
    gatewayToken: GATEWAY_TOKEN,
    fetch: async () => {
      fetchCalls++;
      return jsonResponse(200, {});
    },
  });
  await assert.rejects(
    () => port.requestVoucher(m1(1_000_000, { channel: "C_CANAL_INVALIDO" })),
    (error: unknown) => error instanceof VoucherTransportError && error.retryable === false,
  );
  assert.equal(fetchCalls, 0);
});

// --- withVoucherRetry ----------------------------------------------------------

function scriptedPort(steps: Array<Message2 | Error>): VoucherPort & { calls: number } {
  const port = {
    calls: 0,
    async requestVoucher(): Promise<Message2> {
      const step = steps[Math.min(port.calls, steps.length - 1)]!;
      port.calls++;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return port;
}

test("withVoucherRetry: reintenta un M2 retryable hasta obtener el vale firmado", async () => {
  const signed = await createInMemoryVoucherPort({ depositRaw: 10_000_000n }).requestVoucher(m1(1_000_000));
  const inner = scriptedPort([unsigned("upstream_unavailable"), unsigned("signer_unavailable"), signed]);
  const result = await withVoucherRetry(inner, { sleep: noSleep }).requestVoucher(m1(1_000_000));
  assert.equal(result.status, "signed");
  assert.equal(inner.calls, 3);
});

test("withVoucherRetry: NUNCA reintenta un M2 no reintentable", async () => {
  const inner = scriptedPort([unsigned("channel_exhausted"), unsigned("upstream_unavailable")]);
  const result = await withVoucherRetry(inner, { sleep: noSleep }).requestVoucher(m1(1_000_000));
  assert.equal(result.status, "unsigned");
  if (result.status !== "unsigned") return;
  assert.equal(result.reason, "channel_exhausted");
  assert.equal(inner.calls, 1);
});

test("withVoucherRetry: agotados los intentos devuelve el último M2 reintentable", async () => {
  const inner = scriptedPort([unsigned("internal_error")]);
  const result = await withVoucherRetry(inner, { sleep: noSleep, maxAttempts: 3 }).requestVoucher(m1(1_000_000));
  assert.equal(result.status, "unsigned");
  if (result.status !== "unsigned") return;
  assert.equal(result.reason, "internal_error");
  assert.equal(result.retryable, true);
  assert.equal(inner.calls, 3);
});

test("withVoucherRetry: reintenta fallas de transporte reintentables, no las de configuración", async () => {
  const signed = await createInMemoryVoucherPort({ depositRaw: 10_000_000n }).requestVoucher(m1(1_000_000));
  const flaky = scriptedPort([new VoucherTransportError("ECONNRESET", { retryable: true }), signed]);
  const ok = await withVoucherRetry(flaky, { sleep: noSleep }).requestVoucher(m1(1_000_000));
  assert.equal(ok.status, "signed");
  assert.equal(flaky.calls, 2);

  const misconfigured = scriptedPort([new VoucherTransportError("401", { retryable: false, httpStatus: 401 }), signed]);
  await assert.rejects(
    () => withVoucherRetry(misconfigured, { sleep: noSleep }).requestVoucher(m1(1_000_000)),
    VoucherTransportError,
  );
  assert.equal(misconfigured.calls, 1);
});

test("withVoucherRetry: el deadline corta y devuelve el último M2 reintentable visto", async () => {
  let clock = 0;
  const inner = scriptedPort([unsigned("upstream_unavailable")]);
  const result = await withVoucherRetry(inner, {
    deadlineMs: 1_000,
    now: () => clock,
    random: () => 1,
    sleep: async (ms) => {
      clock += ms;
    },
  }).requestVoucher(m1(1_000_000));
  assert.equal(result.status, "unsigned");
  if (result.status !== "unsigned") return;
  assert.equal(result.reason, "upstream_unavailable");
  assert.ok(inner.calls < 4, `debe cortar antes de agotar los 4 intentos (hizo ${inner.calls})`);
});

// --- createInMemoryVoucherPort ---------------------------------------------------

test("createInMemoryVoucherPort: firma, reusa, rechaza stale y agota contra el depósito", async () => {
  const port = createInMemoryVoucherPort({ depositRaw: 3_000_000n });

  const first = await port.requestVoucher(m1(2_000_000));
  assert.equal(first.status, "signed");
  if (first.status !== "signed") return;
  assert.equal(first.reused, false);
  assert.equal(first.remaining, "1000000");

  const reused = await port.requestVoucher(m1(2_000_000));
  assert.equal(reused.status, "signed");
  if (reused.status !== "signed") return;
  assert.equal(reused.reused, true);
  assert.equal(reused.voucher.signature, first.voucher.signature);

  const stale = await port.requestVoucher(m1(1_000_000));
  assert.equal(stale.status, "unsigned");
  if (stale.status !== "unsigned") return;
  assert.equal(stale.reason, "stale_reading");
  assert.equal(stale.retryable, false);

  const exhausted = await port.requestVoucher(m1(3_000_001));
  assert.equal(exhausted.status, "unsigned");
  if (exhausted.status !== "unsigned") return;
  assert.equal(exhausted.reason, "channel_exhausted");
  assert.equal(exhausted.remaining, "1000000");
});
