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
    channelId: "C1234567890",
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
    logger: () => {},
  });

  const res = await service.processTraffic(500_000); // 0.5 MB consumidos
  assert.equal(res.actionApplied.kind, "noop");
  assert.equal(disabledSimCalls, 0);
  assert.equal(setDataLimitCalls, 0);
  assert.equal(res.meterStatus.cumulativeBytes, 500_000);
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
    channelId: "C1234567890",
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
    logger: () => {},
  });

  // Consumir 2 MB (supera el saldo del canal de 1 MB)
  const res = await service.processTraffic(2_000_000);
  assert.equal(res.actionApplied.kind, "disable");
  assert.equal(disabledSimId, "sim_123");
});
