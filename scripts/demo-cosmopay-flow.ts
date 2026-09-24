/**
 * Script de Demostración E2E: Fondeo con CosmoPay en Stellar Testnet
 * 
 * Flujo:
 * 1. El viajero solicita recargar saldo para su viaje a Brasil.
 * 2. CosmoPayService genera un Payment Intent SEP-7 (URI + QR) en Stellar Testnet.
 * 3. El usuario firma y paga la transacción usando Cosmo Wallet en Testnet.
 * 4. Astroam valida el txHash con CosmoPay.
 * 5. Los $5.00 USDC acreditados inicializan el canal Soroban y habilitan la eSIM de Telnyx.
 * 6. El viajero consume megabytes de datos progresivamente en Brasil.
 * 
 * Para ejecutar:
 *   npx tsx scripts/demo-cosmopay-flow.ts
 */

import { CosmoPayService } from "../src/services/CosmoPayService.ts";
import { IntegratedMeterService, createStellarChannelBalanceAdapter } from "../src/meter/meter-service.ts";
import { createInMemoryVoucherPort } from "../src/meter/voucher-port.ts";
import { pricePerMibFromPerMbRaw } from "../src/shared/money.ts";
import type { ConnectivityProvider } from "../src/providers/connectivity/ConnectivityProvider.ts";
import { createConnectivitySession, type ConnectivitySession } from "../src/models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../src/server/channel-service.ts";

async function runCosmoPayDemo() {
  console.log("=======================================================================");
  console.log("🚀 DEMO ASTROAM: FONDEO CON COSMOPAY Y BILLETERA STELLAR TESTNET");
  console.log("=======================================================================\n");

  const cosmoPay = new CosmoPayService();
  console.log(`ℹ️  Modo CosmoPay: ${cosmoPay.isMock ? "SANDBOX / MOCK (Consola local)" : "ENV TEST (API Live dv_)"}\n`);

  // 1. Crear el Payment Intent de Fondeo ($5.00 USDC)
  const depositAmountUsdc = "5.00";
  console.log(`📋 1. Creando Payment Intent SEP-7 en CosmoPay por $${depositAmountUsdc} USDC...`);
  
  const intent = await cosmoPay.createDepositIntent({
    amount: depositAmountUsdc,
    msg: "Astroam eSIM Roaming Data Deposit - Brasil",
  });

  console.log("✅ Intención de Pago Creada con Éxito:");
  console.log(`   • ID de Intención : ${intent.id}`);
  console.log(`   • Monto solicitado : ${intent.amount} ${intent.asset}`);
  console.log(`   • Destino Escrow   : ${intent.destination}`);
  console.log(`   • URI SEP-7        : ${intent.uri}`);
  console.log(`   • QR Code (Base64) : ${intent.qr.substring(0, 45)}...\n`);

  console.log("📲 2. Instrucciones para la billetera:");
  console.log("   --> El usuario escanea el QR o abre la URI en Cosmo Wallet (Firefox/Web).");
  console.log("   --> Confirma y firma la transacción en Stellar Testnet.\n");

  // 2. Simular la firma de la transacción por el usuario
  console.log("⚡ 3. Simulando confirmación de firma y transmisión a la red Stellar Testnet...");
  const simulatedTxHash = "c6e8f4981a3d902e48512b98f24097e3a2b1049b498f7e8a1d2c3b4a5f6e7d8c";
  
  const validation = await intent.validate(simulatedTxHash);
  console.log(`🔍 Resultado de Validación CosmoPay: Valid=${validation.valid} | Status=${validation.status}\n`);

  if (!validation.valid) {
    console.error("❌ El depósito no pudo ser verificado. Abortando fondeo.");
    return;
  }

  console.log("=======================================================================");
  console.log("🎉 DEPÓSITO CONFIRMADO: ACTIVANDO CANAL SOROBAN Y ESIM DE NAVEGACIÓN");
  console.log("=======================================================================\n");

  // 3. Inicializar el canal Soroban y el medidor de datos con los $5.00 USDC depositados
  const initialChannelDepositRaw = 50_000_000n; // $5.00 USDC en raw units, 1 raw = 1e-7 USDC (2.000 MB a 0,0025 USDC/MB)
  // 0,0025 USDC por MB = USD 2,48/GB: tarifa pública de Citrus Mobile en Brasil (USD 1,84/GB) × 1,35
  const pricePerMbRaw = 25_000n;
  const channelStatePort: ChannelStatePort = {
    async getChannelInfo(_channel: string) {
      return {
        found: true,
        depositRaw: initialChannelDepositRaw,
        balanceRaw: initialChannelDepositRaw,
        closeEffectiveAtLedger: null,
        currentLedger: 108920,
        to: intent.destination,
        token: "C_USDC_CONTRACT_TESTNET",
      };
    },
  };

  const mockTelnyxProvider: ConnectivityProvider = {
    async purchaseEsim(userId: string) {
      return { simCardId: "sim_cosmopay_001", iccid: "8955109876543210123F", activationCode: "LPA:1$qr$sim001" };
    },
    async enable(simCardId: string) {
      console.log(`🟢 [TELNYX eSIM] SIM ${simCardId} HABILITADA para datos móviles en Brasil.`);
    },
    async disable(simCardId: string) {
      console.log(`🔴 [TELNYX eSIM] SIM ${simCardId} DESHABILITADA (Corte de Datos por Límite de Saldo).`);
    },
    async setDataLimit(simCardId: string, limitMb: number) {
      console.log(`📉 [TELNYX eSIM] data_limit asignado a SIM ${simCardId}: ${limitMb.toFixed(2)} MB`);
    },
    async getUsage() {
      return { mb: 0, status: "enabled" };
    },
  };

  const esim = await mockTelnyxProvider.purchaseEsim("user_danipalermo");
  await mockTelnyxProvider.enable(esim.simCardId);

  const session: ConnectivitySession = createConnectivitySession({
    id: "sess_cosmopay_2026",
    userId: "user_danipalermo",
    // Formato de contrato Soroban válido (C + 55 base32): lo exige el M1 de POST /vouchers.
    channelId: "CCOSMOPAYDEMOCANALAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    simCardId: esim.simCardId,
    iccid: esim.iccid,
  });

  const balanceAdapter = createStellarChannelBalanceAdapter(channelStatePort);
  const meterService = new IntegratedMeterService({
    session,
    provider: mockTelnyxProvider,
    balancePort: balanceAdapter,
    pricePerMbRaw,
    // Vales offline: doble en memoria del agente de pagos (POST /vouchers)
    voucherPort: createInMemoryVoucherPort({ depositRaw: initialChannelDepositRaw }),
    network: "stellar:testnet",
    voucherPricePerMibRaw: pricePerMibFromPerMbRaw(pricePerMbRaw), // misma tarifa, expresada por MiB
    meterConfig: {
      chunkSizeBytes: 1_000_000,
      maxUnpaidQuotaBytes: 1_000_000,
    },
    logger: (line) => console.log(`   ${line}`),
  });

  console.log("\n📲 [ESTADO INICIAL] Fondeo Validado con CosmoPay | Saldo en Soroban: $5.00 USDC (~2.000 MB a 0,0025 USDC/MB)");
  console.log("----------------------------------------------------------------------------------");

  // 4. Simulación de Consumo de MBs
  console.log("\n🚗 [TRAMO 1] El viajero usa GPS y WhatsApp en Río de Janeiro (+300 MB)...");
  await meterService.processTraffic(300_000_000);

  console.log("\n📸 [TRAMO 2] El viajero sube fotos y audios (+700 MB, acumulado = 1.000 MB)...");
  await meterService.processTraffic(700_000_000);

  console.log("\n📹 [TRAMO 3] Videollamada (+800 MB, acumulado = 1.800 MB)...");
  await meterService.processTraffic(800_000_000);

  console.log("\n⚠️ [TRAMO 4] Intentando reproducir video HD (+600 MB, acumulado = 2.400 MB, supera depósito de $5.00 USDC)...");
  const result = await meterService.processTraffic(600_000_000);

  console.log("\n=======================================================================");
  console.log("📌 RESULTADO FINAL DE LA DEMO DE COSMOPAY");
  console.log("=======================================================================");
  console.log(`• Intención CosmoPay Validada: ${intent.id} ($${intent.amount} ${intent.asset})`);
  console.log(`• Bytes Medidos por Gateway : ${result.meterStatus.cumulativeBytes.toLocaleString()} bytes (~${(result.meterStatus.cumulativeBytes / 1_000_000).toLocaleString()} MB)`);
  console.log(`• Depósito Soroban Registrado: ${initialChannelDepositRaw.toString()} raw units (5.00 USDC)`);
  console.log(`• Estado de la SIM Telnyx    : ${result.actionApplied.kind === "disable" ? "DESHABILITADA 🔴" : "ACTIVA 🟢"}`);
  console.log("=======================================================================\n");
}

runCosmoPayDemo().catch(console.error);
