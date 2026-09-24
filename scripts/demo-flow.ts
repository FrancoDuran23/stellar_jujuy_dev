/**
 * Script de Flujo Completo End-to-End (Demo Hackathon)
 * 
 * Simula el viaje completo de un argentino en Brasil:
 * 1. Aprovisionamiento de la eSIM (Telnyx) y apertura de canal en Soroban (Stellar).
 * 2. Navegación y consumo progresivo de bytes a través del medidor.
 * 3. Firma y verificación de vales acumulativos (MPP).
 * 4. Ajuste automático de límites en Telnyx y corte si se agota el saldo.
 * 
 * Para ejecutar:
 *   npm run demo:flow
 *
 * Vales (paso 3):
 * - Por defecto (sin `AGENT_VOUCHERS_URL`): 100% offline, con un doble en
 *   memoria del agente (`createInMemoryVoucherPort`) que aplica sus mismas
 *   reglas (idempotencia por acumulado, agotamiento contra el depósito).
 * - Con `AGENT_VOUCHERS_URL` (ej. http://127.0.0.1:8081/vouchers, con
 *   `npm run agent:serve` corriendo): pide los vales al agente REAL por HTTP.
 *   Requiere además `GATEWAY_TOKEN`, `CHANNEL_CONTRACT` y `PRICE_PER_MIB_RAW`
 *   (los mismos valores que lee el agente) y opcionalmente `STELLAR_NETWORK`.
 *   Telnyx y el depósito del canal siguen simulados.
 */

import "dotenv/config";
import {
  IntegratedMeterService,
  createStellarChannelBalanceAdapter,
  type VoucherRequestResult,
} from "../src/meter/meter-service.ts";
import { createAgentVoucherPort, createInMemoryVoucherPort, type VoucherPort } from "../src/meter/voucher-port.ts";
import type { ConnectivityProvider } from "../src/providers/connectivity/ConnectivityProvider.ts";
import { createConnectivitySession, type ConnectivitySession } from "../src/models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../src/server/channel-service.ts";
import { parseNonNegativeIntegerRaw } from "../src/shared/money.ts";
import { isStellarContractId } from "../src/shared/stellar/keys.ts";
import { isNetwork, type Network } from "../src/shared/stellar/network.ts";

/** Contrato de canal ficticio con formato válido (C + 55 base32) para el modo offline. */
const DEMO_CHANNEL_ID = "CDEMOCANALSOROBANJUJUYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** 1 USDC por MB decimal = 1_048_576 raw por MiB (el agente cotiza por MiB). */
const DEMO_PRICE_PER_MIB_RAW = 1_048_576n;

type VoucherSetup = {
  mode: "offline" | "agent";
  voucherPort: VoucherPort;
  channelId: string;
  network: Network;
  pricePerMibRaw: bigint;
};

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

/** Elige el puerto de vales: agente real por HTTP si hay `AGENT_VOUCHERS_URL`,
 * si no el doble offline. Falla rápido si el modo real está a medio configurar. */
function resolveVoucherSetup(env: NodeJS.ProcessEnv, depositRaw: bigint): VoucherSetup {
  const url = envValue(env, "AGENT_VOUCHERS_URL");
  if (url === undefined) {
    return {
      mode: "offline",
      voucherPort: createInMemoryVoucherPort({ depositRaw }),
      channelId: DEMO_CHANNEL_ID,
      network: "stellar:testnet",
      pricePerMibRaw: DEMO_PRICE_PER_MIB_RAW,
    };
  }

  const gatewayToken = envValue(env, "GATEWAY_TOKEN");
  const channelId = envValue(env, "CHANNEL_CONTRACT");
  const rawPrice = envValue(env, "PRICE_PER_MIB_RAW");
  const network = envValue(env, "STELLAR_NETWORK") ?? "stellar:testnet";
  const pricePerMibRaw = rawPrice === undefined ? undefined : parseNonNegativeIntegerRaw(rawPrice);
  const problems: string[] = [];
  if (gatewayToken === undefined) problems.push("falta GATEWAY_TOKEN");
  if (channelId === undefined || !isStellarContractId(channelId)) problems.push("CHANNEL_CONTRACT falta o no es un contrato C... de 56 chars");
  if (pricePerMibRaw === undefined || pricePerMibRaw === 0n) problems.push("PRICE_PER_MIB_RAW falta o no es un entero positivo");
  if (!isNetwork(network)) problems.push(`STELLAR_NETWORK inválida: "${network}"`);
  if (problems.length > 0 || gatewayToken === undefined || channelId === undefined || pricePerMibRaw === undefined || !isNetwork(network)) {
    throw new Error(`AGENT_VOUCHERS_URL está definida pero la config del modo agente es inválida: ${problems.join("; ")}`);
  }

  return {
    mode: "agent",
    voucherPort: createAgentVoucherPort({ url, gatewayToken }),
    channelId,
    network,
    pricePerMibRaw,
  };
}

function describeVoucher(voucher: VoucherRequestResult): string {
  switch (voucher.kind) {
    case "signed":
      return `firmado por ${voucher.envelope.voucher.cumulativeAmount} raw${voucher.envelope.reused ? " (reused)" : ""}`;
    case "unsigned":
      return `NO firmado: ${voucher.envelope.reason} (retryable=${voucher.envelope.retryable})`;
    case "unavailable":
      return `sin respuesta del agente: ${voucher.detail}`;
  }
}

async function runDemoFlow() {
  console.log("===============================================================");
  console.log("✈️  SIMULACIÓN: VIAJERO ARGENTINO ATERRIZA EN BRASIL");
  console.log("===============================================================\n");

  // 1. Simular la respuesta de Telnyx (Proveedor de Conectividad)
  const mockTelnyxProvider: ConnectivityProvider = {
    async purchaseEsim(userId: string) {
      console.log(`📡 [TELNYX API] Aprovisionando eSIM para usuario ${userId}...`);
      return {
        simCardId: "sim_br_99812",
        iccid: "8955101234567890123F",
        activationCode: "LPA:1$qr.telnyx.com$sim_br_99812",
      };
    },
    async enable(simCardId: string) {
      console.log(`🟢 [TELNYX API] SIM ${simCardId} HABILITADA en antenas Vivo/TIM.`);
    },
    async disable(simCardId: string) {
      console.log(`🔴 [TELNYX API] SIM ${simCardId} DESHABILITADA (Corte de Datos por Límite de Saldo).`);
    },
    async setDataLimit(simCardId: string, limitMb: number) {
      console.log(`📉 [TELNYX API] Nuevo data_limit asignado a SIM ${simCardId}: ${limitMb} MB.`);
    },
    async getUsage(_simCardId: string) {
      return { mb: 120, status: "enabled" };
    },
  };

  // 2. Simular el estado del Canal de Soroban en la red de Stellar
  const initialChannelDepositRaw = 5_000_000n; // 5 USDC en raw units (5 MB a 1 USDC/MB)
  const mockChannelStatePort: ChannelStatePort = {
    async getChannelInfo(_channel: string) {
      return {
        found: true,
        depositRaw: initialChannelDepositRaw,
        balanceRaw: initialChannelDepositRaw,
        closeEffectiveAtLedger: null,
        currentLedger: 104520,
        to: "G_RECEPTOR_STELLAR...",
        token: "C_USDC_CONTRACT...",
      };
    },
  };

  // 3. Crear sesión del viajero
  const esim = await mockTelnyxProvider.purchaseEsim("user_argentino_123");
  await mockTelnyxProvider.enable(esim.simCardId);

  // Vales: doble offline por defecto, agente real si hay AGENT_VOUCHERS_URL
  const vouchers = resolveVoucherSetup(process.env, initialChannelDepositRaw);
  console.log(
    vouchers.mode === "agent"
      ? `🧾 [VALES] Modo AGENTE REAL: POST ${process.env.AGENT_VOUCHERS_URL} (canal ${vouchers.channelId})`
      : "🧾 [VALES] Modo OFFLINE: doble en memoria del agente de pagos (definí AGENT_VOUCHERS_URL para usar el real)",
  );

  const session: ConnectivitySession = createConnectivitySession({
    id: "sess_brasil_2026",
    userId: "user_argentino_123",
    channelId: vouchers.channelId,
    simCardId: esim.simCardId,
    iccid: esim.iccid,
  });

  const balanceAdapter = createStellarChannelBalanceAdapter(mockChannelStatePort);

  const meterService = new IntegratedMeterService({
    session,
    provider: mockTelnyxProvider,
    balancePort: balanceAdapter,
    pricePerMbRaw: 1_000_000n, // 1 USDC por MB (1,000,000 raw units)
    voucherPort: vouchers.voucherPort,
    network: vouchers.network,
    voucherPricePerMibRaw: vouchers.pricePerMibRaw,
    meterConfig: {
      chunkSizeBytes: 1_000_000,
      maxUnpaidQuotaBytes: 1_000_000,
    },
    logger: (line) => console.log(`   ${line}`),
  });

  console.log("\n📲 [ESTADO INICIAL] Perfil eSIM activo | Saldo depositado en Canal Stellar: 5.00 USDC");
  console.log("----------------------------------------------------------------------------------");

  // 4. Tramo 1: Navegación normal (2 MB)
  console.log("\n🚗 [TRAMO 1] El viajero usa GPS y WhatsApp en Florianópolis (+2 MB)...");
  await meterService.processTraffic(2_000_000);

  // 5. Tramo 2: Ver fotos/videos (+2 MB, consumo acumulado = 4 MB)
  console.log("\n📸 [TRAMO 2] El viajero sube fotos en la playa (+2 MB)...");
  await meterService.processTraffic(2_000_000);

  // 6. Tramo 3: Se intenta consumir 2 MB más (Excede el saldo de 5 MB)
  console.log("\n⚠️ [TRAMO 3] Intentando reproducir video (+2 MB, acumulado = 6 MB, supera depósito de 5 USDC)...");
  const result = await meterService.processTraffic(2_000_000);

  console.log("\n===============================================================");
  console.log("📌 RESULTADO FINAL DE LA DEMO");
  console.log("===============================================================");
  console.log(`• Bytes Medidos por el Gateway:  ${result.meterStatus.cumulativeBytes.toLocaleString()} bytes (~6.0 MB)`);
  console.log(`• Depósito del Canal de Soroban: ${initialChannelDepositRaw.toString()} raw units (5.0 USDC)`);
  console.log(`• Último vale (POST /vouchers):  ${describeVoucher(result.voucher)}`);
  console.log(`• Cuota pagada en el medidor:   ${result.meterStatus.paidQuotaMb}`);
  console.log(`• Estado de la SIM en Telnyx:   ${result.actionApplied.kind === "disable" ? "DESHABILITADA 🔴" : "ACTIVA 🟢"}`);
  console.log("===============================================================\n");
}

runDemoFlow().catch(console.error);
