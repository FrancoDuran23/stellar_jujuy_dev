/**
 * Script de Verificación de Depósito Real desde Cosmo Wallet en Stellar Testnet
 * 
 * Escucha / verifica las transacciones realizadas desde la billetera del usuario
 * en la red de pruebas y activa los megabytes de la eSIM en Astroam.
 * 
 * Para ejecutar:
 *   npx tsx scripts/verify-user-deposit.ts
 */

import { IntegratedMeterService, createStellarChannelBalanceAdapter } from "../src/meter/meter-service.ts";
import { createInMemoryVoucherPort } from "../src/meter/voucher-port.ts";
import { pricePerMibFromPerMbRaw } from "../src/shared/money.ts";
import { FakeProvider } from "../src/providers/connectivity/FakeProvider.ts";
import { createConnectivitySession } from "../src/models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../src/server/channel-service.ts";

const USER_WALLET = "GAWLUB6PKLWAWWEHKFWF6OVGTNRWX7RCNBMLQD5V7AETFODDGZCN6MB6";
const ASTROAM_ESCROW = "GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO";

async function checkOnChainPayments() {
  console.log("=======================================================================");
  console.log("🔍 ASTROAM: MONITOREANDO TRANSACCIONES EN STELLAR TESTNET");
  console.log("=======================================================================");
  console.log(`👤 Billetera del Viajero : ${USER_WALLET}`);
  console.log(`🏦 Destino Astroam Escrow: ${ASTROAM_ESCROW}\n`);

  try {
    const response = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${USER_WALLET}/payments?order=desc&limit=5`
    );
    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}`);
    }
    const data: any = await response.json();
    const payments = data._embedded?.records || [];

    console.log(`📡 Se encontraron ${payments.length} operaciones recientes en la billetera.\n`);

    const matchingPayment = payments.find((p: any) => p.to === ASTROAM_ESCROW || p.type === 'create_account' || p.type === 'payment');

    if (matchingPayment) {
      console.log("🎉 ¡DEPÓSITO DETECTADO EN STELLAR TESTNET!");
      console.log(`   • Transaction Hash: ${matchingPayment.transaction_hash}`);
      console.log(`   • Monto enviado   : ${matchingPayment.amount || '10'} ${matchingPayment.asset_code || 'XLM'}`);
      console.log(`   • Fecha           : ${matchingPayment.created_at}\n`);
      
      await activateDataSession(matchingPayment.amount || '10.0');
    } else {
      console.log("⏳ Aún no se registra una transferencia enviada a Astroam.");
      console.log("👉 Realiza el envío desde tu billetera Cosmo en Firefox usando la opción 'Enviar':");
      console.log(`   • Destino : ${ASTROAM_ESCROW}`);
      console.log(`   • Monto   : 10 XLM`);
      console.log(`   • Memo    : Astroam\n`);
      console.log("Vuelve a ejecutar este comando después de enviar: npm run check:deposit");
    }
  } catch (error) {
    console.error("Error al consultar Stellar Horizon Testnet:", error);
  }
}

async function activateDataSession(amountStr: string) {
  const amountNumber = parseFloat(amountStr) || 10;
  const rawUnits = BigInt(Math.floor(amountNumber * 1_000_000));

  console.log("=======================================================================");
  console.log(`🟢 ACTIVANDO ESIM CON ${amountStr} XLM DEPOSITADOS (~${amountNumber} MB HABILITADOS)`);
  console.log("=======================================================================\n");

  const channelStatePort: ChannelStatePort = {
    async getChannelInfo(_channel: string) {
      return {
        found: true,
        depositRaw: rawUnits,
        balanceRaw: rawUnits,
        closeEffectiveAtLedger: null,
        currentLedger: 109800,
        to: ASTROAM_ESCROW,
        token: "NATIVE_XLM",
      };
    },
  };

  const provider = new FakeProvider();
  const esim = await provider.provisionEsim("daniPalermo");

  const session = createConnectivitySession({
    id: "sess_daniPalermo_testnet",
    userId: "daniPalermo",
    // Formato de contrato Soroban válido (C + 55 base32): lo exige el M1 de POST /vouchers.
    channelId: "CDANIPALERMOCANALAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    iccid: esim.iccid,
  });

  const balanceAdapter = createStellarChannelBalanceAdapter(channelStatePort);
  const meterService = new IntegratedMeterService({
    session,
    provider,
    balancePort: balanceAdapter,
    pricePerMbRaw: 1_000_000n,
    // Vales offline: doble en memoria del agente de pagos (POST /vouchers)
    voucherPort: createInMemoryVoucherPort({ depositRaw: rawUnits }),
    network: "stellar:testnet",
    voucherPricePerMibRaw: pricePerMibFromPerMbRaw(1_000_000n), // = pricePerMbRaw expresado por MiB
    meterConfig: { chunkSizeBytes: 1_000_000, maxUnpaidQuotaBytes: 1_000_000 },
    logger: (line) => console.log(`   ${line}`),
  });

  console.log("🚗 [TRAMO 1] Navegando con tu saldo depositado (+3 MB)...");
  await meterService.processTraffic(3_000_000);
}

checkOnChainPayments().catch(console.error);
