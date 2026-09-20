/**
 * Servidor / Integrador del Medidor con la Política de Corte y el Estado del Canal de Stellar.
 * 
 * Une:
 * - NetworkDataMeter (Medidor de tráfico en tiempo real)
 * - PolicyEnforcer (Reglas de decisión y cortes en Telnyx)
 * - ChannelBalancePort (Adaptador con la red de Stellar/Soroban)
 */

import { NetworkDataMeter, type MeterConfig } from "./demo-meter.ts";
import {
  decidePolicy,
  type ChannelBalancePort,
  type EnforcementAction,
  BYTES_PER_MB,
} from "../services/PolicyEnforcer.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../server/channel-service.ts";

/**
 * Adaptador que convierte un ChannelStatePort de Stellar/Soroban
 * en el ChannelBalancePort que consume PolicyEnforcer.
 */
export function createStellarChannelBalanceAdapter(
  channelStatePort: ChannelStatePort,
): ChannelBalancePort {
  return {
    async getChannelBalance(channelId: string): Promise<bigint> {
      const info = await channelStatePort.getChannelInfo(channelId);
      if (!info.found) {
        throw new Error(`Canal de Stellar no encontrado en la red: ${channelId}`);
      }
      return info.depositRaw;
    },
  };
}

export interface MeterServiceOptions {
  session: ConnectivitySession;
  provider: ConnectivityProvider;
  balancePort: ChannelBalancePort;
  meterConfig?: Partial<MeterConfig>;
  pricePerMbRaw: bigint;
  logger?: (msg: string) => void;
}

export class IntegratedMeterService {
  private meter: NetworkDataMeter;
  private session: ConnectivitySession;
  private provider: ConnectivityProvider;
  private balancePort: ChannelBalancePort;
  private pricePerMbRaw: bigint;
  private logger: (msg: string) => void;

  constructor(opts: MeterServiceOptions) {
    this.session = opts.session;
    this.provider = opts.provider;
    this.balancePort = opts.balancePort;
    this.pricePerMbRaw = opts.pricePerMbRaw;
    this.logger = opts.logger ?? console.log;
    this.meter = new NetworkDataMeter(opts.meterConfig);
  }

  /**
   * Registra una ráfaga de tráfico en el medidor y ejecuta la evaluación
   * de políticas contra el depósito del canal en Stellar y la SIM en Telnyx.
   */
  public async processTraffic(bytesTransferred: number): Promise<{
    meterStatus: ReturnType<NetworkDataMeter["getStatus"]>;
    actionApplied: EnforcementAction;
  }> {
    // 1. Registrar tráfico en el medidor local
    const { cumulativeBytes } = this.meter.recordTraffic(bytesTransferred);
    this.session.meteredBytes = BigInt(cumulativeBytes);

    // 2. Consultar el saldo/depósito del canal de Stellar
    const balanceRaw = await this.balancePort.getChannelBalance(this.session.channelId);

    // 3. Evaluar la política de corte
    const costRaw = (BigInt(cumulativeBytes) * this.pricePerMbRaw) / BYTES_PER_MB;
    const action = decidePolicy({
      balanceRaw,
      costRaw,
      pricePerMbRaw: this.pricePerMbRaw,
    });

    // 4. Aplicar los efectos secundarios en Telnyx si corresponde y sincronizar la cuota
    switch (action.kind) {
      case "disable":
        this.logger(`🚨 [POLICY ENFORCER] Deshabilitando SIM en Telnyx: ${action.reason}`);
        await this.provider.disableSIM(this.session.simCardId);
        break;

      case "set_data_limit":
        this.logger(`📉 [POLICY ENFORCER] Ajustando tope de datos en Telnyx a ${action.mb} MB`);
        await this.provider.setDataLimit(this.session.simCardId, action.mb);
        // Sincronizar cuota acreditada en el medidor basada en el saldo restante del canal
        this.meter.creditPaidQuota(cumulativeBytes);
        break;

      case "noop":
        this.logger(`✅ [POLICY ENFORCER] Tráfico dentro del saldo. Sin cambios en Telnyx.`);
        // Sincronizar cuota acreditada en el medidor basada en el saldo verificado del canal
        this.meter.creditPaidQuota(cumulativeBytes);
        break;
    }

    return {
      meterStatus: this.meter.getStatus(),
      actionApplied: action,
    };
  }

  public getMeter(): NetworkDataMeter {
    return this.meter;
  }
}
