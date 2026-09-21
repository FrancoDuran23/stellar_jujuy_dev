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
 */

import { IntegratedMeterService, createStellarChannelBalanceAdapter } from "../src/meter/meter-service.ts";
import type { ConnectivityProvider } from "../src/providers/connectivity/ConnectivityProvider.ts";
import { createConnectivitySession, type ConnectivitySession } from "../src/models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../src/server/channel-service.ts";

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

  const session: ConnectivitySession = createConnectivitySession({
    id: "sess_brasil_2026",
    userId: "user_argentino_123",
    channelId: "C_CANAL_SOROBAN_123",
    simCardId: esim.simCardId,
    iccid: esim.iccid,
  });

  const balanceAdapter = createStellarChannelBalanceAdapter(mockChannelStatePort);

  const meterService = new IntegratedMeterService({
    session,
    provider: mockTelnyxProvider,
    balancePort: balanceAdapter,
    pricePerMbRaw: 1_000_000n, // 1 USDC por MB (1,000,000 raw units)
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
  console.log(`• Estado de la SIM en Telnyx:   ${result.actionApplied.kind === "disable" ? "DESHABILITADA 🔴" : "ACTIVA 🟢"}`);
  console.log("===============================================================\n");
}

runDemoFlow().catch(console.error);
