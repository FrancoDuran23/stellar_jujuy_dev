/**
 * Script de Flujo Completo End-to-End (Demo Hackathon)
 * 
 * Simula el viaje completo de un argentino en Brasil:
 * 1. Aprovisionamiento de la eSIM (Citrus, backend `fake` en esta demo) y apertura de canal en Soroban (Stellar).
 * 2. Navegación y consumo progresivo de bytes a través del medidor.
 * 3. Firma y verificación de vales acumulativos (MPP).
 * 4. Corte de datos si se agota el saldo del canal (política suspend/noop, R8).
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
 *   Citrus y el depósito del canal siguen simulados.
 */

import "dotenv/config";
import {
  IntegratedMeterService,
  createStellarChannelBalanceAdapter,
  type VoucherRequestResult,
} from "../src/meter/meter-service.ts";
import { createAgentVoucherPort, createInMemoryVoucherPort, type VoucherPort } from "../src/meter/voucher-port.ts";
import { FakeProvider } from "../src/providers/connectivity/FakeProvider.ts";
import { createConnectivitySession, type ConnectivitySession } from "../src/models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../src/server/channel-service.ts";
import { arePricesAligned, parseNonNegativeIntegerRaw, pricePerMibFromPerMbRaw } from "../src/shared/money.ts";
import { isStellarContractId } from "../src/shared/stellar/keys.ts";
import { isNetwork, type Network } from "../src/shared/stellar/network.ts";

/** Contrato de canal ficticio con formato válido (C + 55 base32) para el modo offline. */
const DEMO_CHANNEL_ID = "CDEMOCANALSOROBANJUJUYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** Tarifa de la demo: 0,0025 USDC por MB decimal (1 raw = 1e-7 USDC), o sea
 * USD 2,48/GB = tarifa pública de Citrus Mobile en Brasil (USD 1,84/GB) × 1,35. */
const DEMO_PRICE_PER_MB_RAW = 25_000n;
/** La misma tarifa expresada por MiB (el agente cotiza por MiB): 26_215 raw. */
const DEMO_PRICE_PER_MIB_RAW = pricePerMibFromPerMbRaw(DEMO_PRICE_PER_MB_RAW);

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
  else if (!arePricesAligned(DEMO_PRICE_PER_MB_RAW, pricePerMibRaw)) {
    problems.push(`PRICE_PER_MIB_RAW=${pricePerMibRaw} no coincide con la tarifa de la demo (0,0025 USDC/MB); usá ${DEMO_PRICE_PER_MIB_RAW}`);
  }
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

  // 1. Simular la respuesta de Citrus (Proveedor de Conectividad)
  const provider = new FakeProvider();

  // 2. Simular el estado del Canal de Soroban en la red de Stellar
  const initialChannelDepositRaw = 50_000_000n; // 5 USDC en raw units (2.000 MB a 0,0025 USDC/MB)
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
  const esim = await provider.provisionEsim("user_argentino_123");

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
    iccid: esim.iccid,
  });

  const balanceAdapter = createStellarChannelBalanceAdapter(mockChannelStatePort);

  const meterService = new IntegratedMeterService({
    session,
    provider,
    balancePort: balanceAdapter,
    pricePerMbRaw: DEMO_PRICE_PER_MB_RAW, // 0,0025 USDC por MB (25,000 raw units)
    voucherPort: vouchers.voucherPort,
    network: vouchers.network,
    voucherPricePerMibRaw: vouchers.pricePerMibRaw,
    meterConfig: {
      chunkSizeBytes: 1_000_000,
      maxUnpaidQuotaBytes: 1_000_000,
    },
    logger: (line) => console.log(`   ${line}`),
  });

  console.log("\n📲 [ESTADO INICIAL] Perfil eSIM activo | Saldo depositado en Canal Stellar: 5.00 USDC (~2.000 MB a 0,0025 USDC/MB)");
  console.log("----------------------------------------------------------------------------------");

  // 4. Tramo 1: mapas y mensajería (300 MB → 0,75 USDC, sin cambios)
  console.log("\n🚗 [TRAMO 1] El viajero usa GPS y WhatsApp en Florianópolis (+300 MB)...");
  await meterService.processTraffic(300_000_000);

  // 5. Tramo 2: fotos (acumulado 1.000 MB → 2,50 USDC, queda 50%)
  console.log("\n📸 [TRAMO 2] El viajero sube fotos de la playa (+700 MB, acumulado = 1.000 MB)...");
  await meterService.processTraffic(700_000_000);

  // 6. Tramo 3: videollamada (acumulado 1.800 MB → 4,50 USDC, queda 10%: se baja el tope)
  console.log("\n📹 [TRAMO 3] Videollamada con la familia (+800 MB, acumulado = 1.800 MB)...");
  await meterService.processTraffic(800_000_000);

  // 7. Tramo 4: streaming (acumulado 2.400 MB → 6,00 USDC, supera el depósito)
  console.log("\n⚠️ [TRAMO 4] Intentando ver una serie (+600 MB, acumulado = 2.400 MB, supera depósito de 5 USDC)...");
  const result = await meterService.processTraffic(600_000_000);

  console.log("\n===============================================================");
  console.log("📌 RESULTADO FINAL DE LA DEMO");
  console.log("===============================================================");
  console.log(`• Bytes Medidos por el Gateway:  ${result.meterStatus.cumulativeBytes.toLocaleString()} bytes (~${(result.meterStatus.cumulativeBytes / 1_000_000).toLocaleString()} MB)`);
  console.log(`• Depósito del Canal de Soroban: ${initialChannelDepositRaw.toString()} raw units (5.0 USDC)`);
  console.log(`• Último vale (POST /vouchers):  ${describeVoucher(result.voucher)}`);
  console.log(`• Cuota pagada en el medidor:   ${result.meterStatus.paidQuotaMb}`);
  console.log(`• Estado de la SIM:            ${result.actionApplied.kind === "suspend" ? "SUSPENDIDA 🔴" : "ACTIVA 🟢"}`);
  console.log("===============================================================\n");
}

runDemoFlow().catch(console.error);
