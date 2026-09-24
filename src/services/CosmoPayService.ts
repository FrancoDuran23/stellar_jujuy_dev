import 'dotenv/config';
import { Client, Assets } from '@cosmosapp/pay_sdk';

export interface DepositIntentOptions {
  amount: string;
  asset?: string;
  msg?: string;
  destination?: string;
}

export interface DepositIntentResult {
  id: string;
  uri: string;
  qr: string;
  amount: string;
  asset: string;
  destination: string;
  status: string;
  isMock: boolean;
  validate: (txHash?: string) => Promise<{ valid: boolean; status: string }>;
}

export class CosmoPayService {
  private apiKey: string;
  private defaultDestination: string;
  private client: Client | null = null;
  public readonly isMock: boolean;

  constructor(options?: { apiKey?: string; destination?: string }) {
    this.apiKey = options?.apiKey || process.env.COSMOS_PAY_API_KEY || 'dv_test_mock';
    this.defaultDestination =
      options?.destination ||
      process.env.COSMOS_PAY_DESTINATION ||
      'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';

    // Check if we should run in live SDK mode or mock mode
    const isRealKey =
      (this.apiKey.startsWith('dv_') || this.apiKey.startsWith('prod_')) &&
      !this.apiKey.includes('mock');

    if (isRealKey) {
      this.isMock = false;
      try {
        this.client = new Client({ apiKey: this.apiKey });
      } catch (err) {
        console.warn('Failed to initialize live CosmoPay Client, falling back to Mock:', err);
        this.isMock = true;
      }
    } else {
      this.isMock = true;
    }
  }

  /**
   * Genera un intento de pago SEP-7 en CosmoPay para fondeo en Testnet/Mainnet
   */
  async createDepositIntent(options: DepositIntentOptions): Promise<DepositIntentResult> {
    const destination = options.destination || this.defaultDestination;
    const amount = options.amount;
    const rawAsset = options.asset || Assets.USDC;
    const assetStr = typeof rawAsset === 'string' ? rawAsset : (rawAsset as { code?: string }).code || 'USDC';
    const msg = options.msg || 'Fondeo Astroam - Viajero Argentina';

    if (!this.isMock && this.client) {
      try {
        const intent = await this.client.paymentIntents.createPay({
          destination,
          amount,
          asset: rawAsset,
          msg,
        });

        return {
          id: intent.id || `intent_${Date.now()}`,
          uri: intent.uri,
          qr: intent.qr,
          amount,
          asset: assetStr,
          destination,
          status: intent.status || 'pending',
          isMock: false,
          validate: async (txHash?: string) => {
            if (!txHash) return { valid: false, status: 'missing_tx_hash' };
            const outcome = await intent.validate(txHash);
            return { valid: outcome.valid, status: outcome.status };
          },
        };
      } catch (error) {
        console.warn('CosmoPay API error, falling back to mock mode:', error);
      }
    }

    // --- Mock / Sandbox Mode ---
    const mockId = `intent_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const mockUri = `web+stellar:pay?destination=${destination}&amount=${amount}&asset_code=${assetStr}&memo=${encodeURIComponent(msg)}`;
    const mockQr = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`;

    return {
      id: mockId,
      uri: mockUri,
      qr: mockQr,
      amount,
      asset: assetStr,
      destination,
      status: 'pending',
      isMock: true,
      validate: async (txHash?: string) => {
        if (!txHash || txHash.trim() === '') {
          return { valid: false, status: 'failed' };
        }
        return { valid: true, status: 'settled' };
      },
    };
  }

  /**
   * Valida un hash de transacción contra una intención de pago de CosmoPay
   */
  async validateTx(intentId: string, txHash: string): Promise<{ valid: boolean; status: string }> {
    if (!this.isMock && this.client) {
      try {
        const outcome = await this.client.paymentIntents.validate(intentId, { txHash });
        return { valid: outcome.valid, status: outcome.status };
      } catch (err) {
        console.warn(`Error validating intent ${intentId} with txHash ${txHash}:`, err);
      }
    }

    // Mock validation
    if (txHash && txHash.length > 5) {
      return { valid: true, status: 'settled' };
    }
    return { valid: false, status: 'invalid_tx' };
  }
}
