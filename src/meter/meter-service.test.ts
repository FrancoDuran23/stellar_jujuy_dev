import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IntegratedMeterService,
  createStellarChannelBalanceAdapter,
} from "./meter-service.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import {
  createConnectivitySession,
  type ConnectivitySession,
} from "../models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../server/channel-service.ts";
import { buildUnsigned, type Message1, type Message2 } from "../shared/messages.ts";
import {
  VoucherTransportError,
  createInMemoryVoucherPort,
  withVoucherRetry,
  type VoucherPort,
} from "./voucher-port.ts";

/** Contrato de canal con formato válido (C + 55 base32), como en los tests del agente. */
const CHANNEL = `C${"A".repeat(55)}`;
/** 1_048_576 raw/MiB = 1 raw/byte = 1_000_000 raw/MB: el mismo precio que
 * `pricePerMbRaw: 1_000_000n` de la política, expresado por MiB (CF-R2). */
const PRICE_PER_MIB_RAW = 1_048_576n;

function voucherOptions(depositRaw: bigint, voucherPort?: VoucherPort) {
  return {
    voucherPort: voucherPort ?? createInMemoryVoucherPort({ depositRaw }),
    network: "stellar:testnet" as const,
    voucherPricePerMibRaw: PRICE_PER_MIB_RAW,
  };
}

test("createStellarChannelBalanceAdapter: extrae el depositRaw cuando el canal existe", async () => {
  const fakeStatePort: ChannelStatePort = {
    async getChannelInfo(channel: string) {
      assert.equal(channel, "C1234567890");
      return {
        found: true,
        depositRaw: 10_000_000n,
        balanceRaw: 10_000_000n,
        closeEffectiveAtLedger: null,
        currentLedger: 1000,
        to: "GABC...",
        token: "CUSDC...",
      };
    },
  };

  const adapter = createStellarChannelBalanceAdapter(fakeStatePort);
  const balance = await adapter.getChannelBalance("C1234567890");
  assert.equal(balance, 10_000_000n);
});

test("createStellarChannelBalanceAdapter: lanza error si el canal no existe", async () => {
  const fakeStatePort: ChannelStatePort = {
    async getChannelInfo() {
      return { found: false };
    },
  };

  const adapter = createStellarChannelBalanceAdapter(fakeStatePort);
  await assert.rejects(
    () => adapter.getChannelBalance("C_DESCONOCIDO"),
    /Canal de Stellar no encontrado/,
  );
});

test("IntegratedMeterService: procesa tráfico dentro del saldo y mantiene la conexión activa", async () => {
  let disabledSimCalls = 0;
  let setDataLimitCalls = 0;

  const fakeProvider: ConnectivityProvider = {
    async purchaseEsim() {
      return { simCardId: "sim_1", iccid: "89551...", activationCode: "LPA:1$..." };
    },
    async enable() {},
    async disable() {
      disabledSimCalls++;
    },
    async setDataLimit() {
      setDataLimitCalls++;
    },
    async getUsage() {
      return { mb: 0, status: "enabled" };
    },
  };

  const session: ConnectivitySession = createConnectivitySession({
    id: "sess_1",
    userId: "user_1",
    channelId: CHANNEL,
    simCardId: "sim_1",
    iccid: "89551...",
  });

  const fakeBalancePort = {
    async getChannelBalance() {
      return 10_000_000n; // 10 USDC en raw units
    },
  };

  const service = new IntegratedMeterService({
    session,
    provider: fakeProvider,
    balancePort: fakeBalancePort,
    pricePerMbRaw: 1_000_000n, // 1 USDC por MB
    ...voucherOptions(10_000_000n),
    logger: () => {},
  });

  const res = await service.processTraffic(500_000); // 0.5 MB consumidos
  assert.equal(res.actionApplied.kind, "noop");
  assert.equal(disabledSimCalls, 0);
  assert.equal(setDataLimitCalls, 0);
  assert.equal(res.meterStatus.cumulativeBytes, 500_000);
  assert.equal(res.voucher.kind, "signed");
  assert.equal(res.meterStatus.paidQuotaBytes, 500_000);
});

test("IntegratedMeterService: deshabilita la SIM si el consumo agota el saldo del canal", async () => {
  let disabledSimId = "";

  const fakeProvider: ConnectivityProvider = {
    async purchaseEsim() {
      return { simCardId: "sim_1", iccid: "89551...", activationCode: "LPA:1$..." };
    },
    async enable() {},
    async disable(simCardId: string) {
      disabledSimId = simCardId;
    },
    async setDataLimit() {},
    async getUsage() {
      return { mb: 0, status: "enabled" };
    },
  };

  const session: ConnectivitySession = createConnectivitySession({
    id: "sess_1",
    userId: "user_1",
    channelId: CHANNEL,
    simCardId: "sim_123",
    iccid: "89551...",
  });

  const fakeBalancePort = {
    async getChannelBalance() {
      return 1_000_000n; // Saldo muy pequeño: 1 USDC (1 MB)
    },
  };

  const service = new IntegratedMeterService({
    session,
    provider: fakeProvider,
    balancePort: fakeBalancePort,
    pricePerMbRaw: 1_000_000n, // 1 USDC por MB
    ...voucherOptions(10_000_000n),
    logger: () => {},
  });

  // Consumir 2 MB (supera el saldo del canal de 1 MB)
  const res = await service.processTraffic(2_000_000);
  assert.equal(res.actionApplied.kind, "disable");
  assert.equal(disabledSimId, "sim_123");
});

// --- Integración con POST /vouchers (VoucherPort) ---------------------------

type ProviderCalls = { disabled: string[]; dataLimits: number[] };

function recordingProvider(): ConnectivityProvider & { calls: ProviderCalls } {
  const calls: ProviderCalls = { disabled: [], dataLimits: [] };
  return {
    calls,
    async purchaseEsim() {
      return { simCardId: "sim_1", iccid: "89551...", activationCode: "LPA:1$..." };
    },
    async enable() {},
    async disable(simCardId: string) {
      calls.disabled.push(simCardId);
    },
    async setDataLimit(_simCardId: string, mb: number) {
      calls.dataLimits.push(mb);
    },
    async getUsage() {
      return { mb: 0, status: "enabled" };
    },
  };
}

function makeService(opts: {
  balanceRaw: bigint;
  voucherPort: VoucherPort;
  provider?: ConnectivityProvider;
}) {
  const provider = opts.provider ?? recordingProvider();
  const session = createConnectivitySession({
    id: "sess_v",
    userId: "user_1",
    channelId: CHANNEL,
    simCardId: "sim_v",
    iccid: "89551...",
  });
  return new IntegratedMeterService({
    session,
    provider,
    balancePort: {
      async getChannelBalance() {
        return opts.balanceRaw;
      },
    },
    pricePerMbRaw: 1_000_000n,
    ...voucherOptions(opts.balanceRaw, opts.voucherPort),
    meterConfig: { maxUnpaidQuotaBytes: 1_000_000 },
    logger: () => {},
    now: () => new Date("2026-09-23T12:00:00.000Z"),
  });
}

/** Puerto que registra cada M1 y responde con lo que devuelva `respond`. */
function capturingPort(respond: (m1: Message1) => Promise<Message2> | Message2): VoucherPort & { sent: Message1[] } {
  const sent: Message1[] = [];
  return {
    sent,
    async requestVoucher(m1) {
      sent.push(m1);
      return respond(m1);
    },
  };
}

function unsignedFor(m1: Message1, reason: Parameters<typeof buildUnsigned>[0]): Message2 {
  return buildUnsigned(reason, {
    sessionId: m1.sessionId,
    channel: CHANNEL,
    remaining: "0",
    meterReadingId: m1.meterReadingId,
    detail: `test ${reason}`,
  }).body;
}

test("IntegratedMeterService: pide el vale con el M1 del acumulado y acredita solo si el agente firma", async () => {
  const inner = createInMemoryVoucherPort({ depositRaw: 10_000_000n });
  const port = capturingPort((m1) => inner.requestVoucher(m1));
  const service = makeService({ balanceRaw: 10_000_000n, voucherPort: port });

  const first = await service.processTraffic(1_500_000);
  const second = await service.processTraffic(500_000);

  assert.equal(port.sent.length, 2);
  const [m1a, m1b] = port.sent;
  assert.equal(m1a!.channel, CHANNEL);
  assert.equal(m1a!.sessionId, "sess_v");
  assert.equal(m1a!.network, "stellar:testnet");
  assert.equal(m1a!.cumulativeBytes, 1_500_000);
  assert.equal(m1a!.cumulativeAmount, "1500000"); // ceilDiv(bytes × PRICE_PER_MIB_RAW, 1 MiB)
  assert.equal(m1a!.observedAt, "2026-09-23T12:00:00.000Z");
  // Acumulado desde la apertura del canal (VE-R4), nunca el delta
  assert.equal(m1b!.cumulativeBytes, 2_000_000);
  assert.notEqual(m1a!.meterReadingId, m1b!.meterReadingId);

  assert.equal(first.voucher.kind, "signed");
  assert.equal(first.meterStatus.paidQuotaBytes, 1_500_000);
  assert.equal(second.voucher.kind, "signed");
  assert.equal(second.meterStatus.paidQuotaBytes, 2_000_000);
  assert.equal(second.meterStatus.isConnectionActive, true);
});

test("IntegratedMeterService: un rechazo no reintentable NO acredita y el medidor termina cortando", async () => {
  const provider = recordingProvider();
  const port = capturingPort((m1) => unsignedFor(m1, "channel_closing"));
  // Depósito holgado: la política de Telnyx no tiene motivo para actuar.
  const service = makeService({ balanceRaw: 100_000_000n, voucherPort: port, provider });

  const first = await service.processTraffic(800_000);
  assert.equal(first.voucher.kind, "unsigned");
  assert.equal(first.actionApplied.kind, "noop");
  assert.equal(first.meterStatus.paidQuotaBytes, 0);
  assert.equal(first.meterStatus.isConnectionActive, true); // todavía dentro de la cuota impaga

  // Sin vale, el consumo supera la cuota impaga (1 MB) y el medidor corta.
  const second = await service.processTraffic(800_000);
  assert.equal(second.meterStatus.paidQuotaBytes, 0);
  assert.equal(second.meterStatus.isConnectionActive, false);
  // La política de Telnyx no cambia: sin depósito agotado, no toca la SIM.
  assert.deepEqual(provider.calls, { disabled: [], dataLimits: [] });
});

test("IntegratedMeterService: channel_exhausted no acredita y la política deshabilita la SIM", async () => {
  const provider = recordingProvider();
  const service = makeService({
    balanceRaw: 1_000_000n, // 1 MB de depósito
    voucherPort: createInMemoryVoucherPort({ depositRaw: 1_000_000n }),
    provider,
  });

  const res = await service.processTraffic(2_000_000);
  assert.equal(res.voucher.kind, "unsigned");
  if (res.voucher.kind !== "unsigned") return;
  assert.equal(res.voucher.envelope.reason, "channel_exhausted");
  assert.equal(res.voucher.envelope.retryable, false);
  assert.equal(res.actionApplied.kind, "disable");
  assert.deepEqual(provider.calls.disabled, ["sim_v"]);
  assert.equal(res.meterStatus.paidQuotaBytes, 0);
  assert.equal(res.meterStatus.isConnectionActive, false);
});

test("IntegratedMeterService: set_data_limit ajusta Telnyx y acredita solo con vale firmado", async () => {
  const provider = recordingProvider();
  const service = makeService({
    balanceRaw: 5_000_000n,
    voucherPort: createInMemoryVoucherPort({ depositRaw: 5_000_000n }),
    provider,
  });

  // 4 MB de 5 MB: remaining 1 MB ≤ 20% del depósito → set_data_limit(1)
  const res = await service.processTraffic(4_000_000);
  assert.equal(res.actionApplied.kind, "set_data_limit");
  assert.deepEqual(provider.calls.dataLimits, [1]);
  assert.equal(res.voucher.kind, "signed");
  assert.equal(res.meterStatus.paidQuotaBytes, 4_000_000);
  assert.equal(res.meterStatus.isConnectionActive, true);
});

test("IntegratedMeterService: reintenta un reason reintentable y acredita cuando el agente firma", async () => {
  const inner = createInMemoryVoucherPort({ depositRaw: 10_000_000n });
  let calls = 0;
  const flaky: VoucherPort = {
    async requestVoucher(m1) {
      calls++;
      if (calls === 1) return unsignedFor(m1, "upstream_unavailable");
      return inner.requestVoucher(m1);
    },
  };
  const service = makeService({
    balanceRaw: 10_000_000n,
    voucherPort: withVoucherRetry(flaky, { sleep: async () => {} }),
  });

  const res = await service.processTraffic(1_000_000);
  assert.equal(calls, 2);
  assert.equal(res.voucher.kind, "signed");
  assert.equal(res.meterStatus.paidQuotaBytes, 1_000_000);
});

test("IntegratedMeterService: si el reason reintentable persiste, no acredita ni cambia la política", async () => {
  const provider = recordingProvider();
  const port = capturingPort((m1) => unsignedFor(m1, "signer_unavailable"));
  const service = makeService({
    balanceRaw: 10_000_000n,
    voucherPort: withVoucherRetry(port, { sleep: async () => {}, maxAttempts: 2 }),
    provider,
  });

  const res = await service.processTraffic(500_000);
  assert.equal(port.sent.length, 2);
  assert.equal(res.voucher.kind, "unsigned");
  if (res.voucher.kind !== "unsigned") return;
  assert.equal(res.voucher.envelope.retryable, true);
  assert.equal(res.actionApplied.kind, "noop");
  assert.equal(res.meterStatus.paidQuotaBytes, 0);
  assert.deepEqual(provider.calls, { disabled: [], dataLimits: [] });
});

test("IntegratedMeterService: una lectura repetida usa el vale reutilizado (reused) y sigue acreditada", async () => {
  const inner = createInMemoryVoucherPort({ depositRaw: 10_000_000n });
  const port = capturingPort((m1) => inner.requestVoucher(m1));
  const service = makeService({ balanceRaw: 10_000_000n, voucherPort: port });

  const first = await service.processTraffic(1_000_000);
  const repeat = await service.processTraffic(0); // mismo acumulado: reintento idempotente

  assert.equal(first.voucher.kind, "signed");
  assert.equal(repeat.voucher.kind, "signed");
  if (first.voucher.kind !== "signed" || repeat.voucher.kind !== "signed") return;
  assert.equal(first.voucher.envelope.reused, false);
  assert.equal(repeat.voucher.envelope.reused, true);
  assert.equal(repeat.voucher.envelope.voucher.signature, first.voucher.envelope.voucher.signature);
  assert.equal(port.sent[1]!.cumulativeAmount, port.sent[0]!.cumulativeAmount);
  assert.equal(repeat.meterStatus.paidQuotaBytes, 1_000_000);
});

test("IntegratedMeterService: una falla de transporte no lanza, no acredita y deja actuar a la política", async () => {
  const service = makeService({
    balanceRaw: 10_000_000n,
    voucherPort: {
      async requestVoucher() {
        throw new VoucherTransportError("POST /vouchers falló en transporte: ECONNREFUSED", { retryable: true });
      },
    },
  });

  const res = await service.processTraffic(500_000);
  assert.equal(res.voucher.kind, "unavailable");
  assert.equal(res.actionApplied.kind, "noop");
  assert.equal(res.meterStatus.paidQuotaBytes, 0);
});

test("IntegratedMeterService: un vale firmado por menos del acumulado pedido no acredita", async () => {
  const inner = createInMemoryVoucherPort({ depositRaw: 10_000_000n });
  const signedLow = await inner.requestVoucher({
    version: 1,
    sessionId: "sess_v",
    channel: CHANNEL,
    network: "stellar:testnet",
    asset: "USDC",
    cumulativeBytes: 100,
    cumulativeAmount: "100",
    meterReadingId: "mr_low",
    observedAt: "2026-09-23T12:00:00.000Z",
  });
  const service = makeService({
    balanceRaw: 10_000_000n,
    voucherPort: { requestVoucher: async () => signedLow },
  });

  const res = await service.processTraffic(500_000);
  assert.equal(res.voucher.kind, "unavailable");
  assert.equal(res.meterStatus.paidQuotaBytes, 0);
});
