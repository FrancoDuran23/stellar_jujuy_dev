/**
 * Servidor / Integrador del Medidor con la Política de Corte y el Estado del Canal de Stellar.
 *
 * Une:
 * - NetworkDataMeter (Medidor de tráfico en tiempo real — hoy, el accounting local)
 * - VoucherPort (POST /vouchers del agente de pagos MPP — src/meter/voucher-port.ts)
 * - PolicyEnforcer (Reglas de decisión y cortes sobre la eSIM, docs/citrus-mobile-spec.md v2 §7 R8)
 * - ChannelBalancePort (Adaptador con la red de Stellar/Soroban)
 *
 * Regla central: la cuota del medidor SOLO se acredita con un vale firmado
 * (`status: "signed"`, nuevo o `reused`) que cubra el acumulado medido. Un
 * rechazo no reintentable (`channel_exhausted`, `channel_closing`, ...) no
 * acredita nada: el medidor corta solo al superar la cuota impaga, y la
 * política decide el corte de datos del canal (`suspend` la eSIM).
 *
 * Dos entradas:
 * - `processTraffic(bytesTransferred)`: registra una ráfaga real en el medidor y
 *   procesa el nuevo acumulado (escalón legacy / demos; el agente factura bytes).
 * - `processCumulative(cumulativeBytes)`: procesa un acumulado EXTERNO (los
 *   "bytes equivalentes" del spec §6.2 que el usage-loop deriva del consumo
 *   cargado por Citrus). No registra tráfico local: el número YA es el
 *   acumulado por el que se pide el vale.
 */

import { NetworkDataMeter, type MeterConfig } from "./demo-meter.ts";
import {
  decidePolicy,
  computeCostRaw,
  type ChannelBalancePort,
  type EnforcementAction,
} from "../services/PolicyEnforcer.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";
import type { ChannelStatePort } from "../server/channel-service.ts";
import type { Message2Signed, Message2Unsigned } from "../shared/messages.ts";
import { arePricesAligned, pricePerMibFromPerMbRaw } from "../shared/money.ts";
import type { Network } from "../shared/stellar/network.ts";
import { buildMessage1, type VoucherPort } from "./voucher-port.ts";

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
  /** POST /vouchers del agente: sin vale firmado no se acredita cuota. */
  voucherPort: VoucherPort;
  /** Red Stellar del canal (`STELLAR_NETWORK`), viaja en el M1. */
  network: Network;
  /**
   * `PRICE_PER_MIB_RAW` del agente (raw units por MiB = 1_048_576 bytes).
   * Es el precio del VALE y debe ser idéntico al del agente (CF-R2), o el
   * agente responde `amount_rejected`. Distinto de `pricePerMbRaw`, que es
   * el precio por MB decimal de la política (PRICE_PER_MB_RAW); ambos tienen
   * que ser la misma tarifa (`arePricesAligned`) o el constructor lanza.
   */
  voucherPricePerMibRaw: bigint;
  meterConfig?: Partial<MeterConfig>;
  pricePerMbRaw: bigint;
  logger?: (msg: string) => void;
  /** Reloj inyectable para `observedAt` en tests. */
  now?: () => Date;
}

/** Resultado del pedido de vale de una lectura. */
export type VoucherRequestResult =
  /** Vale firmado (nuevo o `reused`) que cubre el acumulado pedido. */
  | { kind: "signed"; envelope: Message2Signed }
  /** El agente respondió, pero no firmó (`reason` + `retryable` explícitos). */
  | { kind: "unsigned"; envelope: Message2Unsigned }
  /** No hubo respuesta de negocio utilizable (red, 401/400, contrato roto). */
  | { kind: "unavailable"; detail: string };

type MeterRunResult = {
  meterStatus: ReturnType<NetworkDataMeter["getStatus"]>;
  actionApplied: EnforcementAction;
  voucher: VoucherRequestResult;
};

export class IntegratedMeterService {
  private meter: NetworkDataMeter;
  private session: ConnectivitySession;
  private provider: ConnectivityProvider;
  private balancePort: ChannelBalancePort;
  private voucherPort: VoucherPort;
  private network: Network;
  private voucherPricePerMibRaw: bigint;
  private pricePerMbRaw: bigint;
  private logger: (msg: string) => void;
  private now: () => Date;
  private readingSeq = 0;

  constructor(opts: MeterServiceOptions) {
    // Agente (por MiB) y política (por MB) deben cobrar la misma tarifa, o no
    // coinciden en cuándo se agota el canal.
    if (!arePricesAligned(opts.pricePerMbRaw, opts.voucherPricePerMibRaw)) {
      throw new RangeError(
        `IntegratedMeterService: precios desalineados — pricePerMbRaw=${opts.pricePerMbRaw} (política, por MB) ` +
          `y voucherPricePerMibRaw=${opts.voucherPricePerMibRaw} (agente, por MiB) no son la misma tarifa; ` +
          `se esperaba voucherPricePerMibRaw=${pricePerMibFromPerMbRaw(opts.pricePerMbRaw)}`,
      );
    }
    this.session = opts.session;
    this.provider = opts.provider;
    this.balancePort = opts.balancePort;
    this.voucherPort = opts.voucherPort;
    this.network = opts.network;
    this.voucherPricePerMibRaw = opts.voucherPricePerMibRaw;
    this.pricePerMbRaw = opts.pricePerMbRaw;
    this.logger = opts.logger ?? console.log;
    this.now = opts.now ?? (() => new Date());
    this.meter = new NetworkDataMeter(opts.meterConfig);
  }

  /**
   * Pide al agente el vale acumulativo que cubre `cumulativeBytes`. Nunca
   * lanza: cualquier falla de transporte (ya reintentada por el puerto, ver
   * `withVoucherRetry`) se devuelve como `unavailable`.
   */
  private async requestVoucher(cumulativeBytes: number): Promise<VoucherRequestResult> {
    this.readingSeq += 1;
    const m1 = buildMessage1({
      sessionId: this.session.id,
      channel: this.session.channelId,
      network: this.network,
      cumulativeBytes,
      pricePerMibRaw: this.voucherPricePerMibRaw,
      meterReadingId: `mr_${this.session.id}_${this.readingSeq}`,
      observedAt: this.now(),
    });

    let envelope;
    try {
      envelope = await this.voucherPort.requestVoucher(m1);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger(`⚠️ [VALE] Agente de pagos no disponible: ${detail}. No se acredita cuota.`);
      return { kind: "unavailable", detail };
    }

    if (envelope.status === "unsigned") {
      if (envelope.retryable) {
        this.logger(
          `⏳ [VALE] Agente respondió ${envelope.reason} (reintentable): ${envelope.detail}. No se acredita cuota; se vuelve a pedir en la próxima lectura.`,
        );
      } else {
        this.logger(
          `⛔ [VALE] Agente rechazó el vale: ${envelope.reason} (no reintentable, remaining=${envelope.remaining} raw). No se acredita cuota.`,
        );
      }
      return { kind: "unsigned", envelope };
    }

    // Defensa: un vale acumulativo por un monto MENOR al pedido no cubre la
    // lectura (el agente nunca debería devolverlo — idempotencia y
    // coalescencia siempre devuelven un monto >= al pedido).
    if (BigInt(envelope.voucher.cumulativeAmount) < BigInt(m1.cumulativeAmount)) {
      const detail = `vale por ${envelope.voucher.cumulativeAmount} raw no cubre el acumulado pedido ${m1.cumulativeAmount} raw`;
      this.logger(`⚠️ [VALE] ${detail}. No se acredita cuota.`);
      return { kind: "unavailable", detail };
    }

    this.logger(
      `🧾 [VALE] Vale ${envelope.reused ? "reutilizado (reused)" : "firmado"} por ${envelope.voucher.cumulativeAmount} raw (remaining=${envelope.remaining} raw).`,
    );
    return { kind: "signed", envelope };
  }

  /**
   * Procesa un ACUMULADO externo (bytes equivalentes del spec §6.2 — la base
   * que pide el usage-loop / el vale final del cierre, R9): pide el vale,
   * evalúa la política contra el depósito del canal y suspende la eSIM si el
   * canal se agotó. No registra tráfico: `cumulativeBytes` YA es el acumulado.
   */
  public async processCumulative(cumulativeBytes: number): Promise<MeterRunResult> {
    const voucher = await this.requestVoucher(cumulativeBytes);
    const balanceRaw = await this.balancePort.getChannelBalance(this.session.channelId);
    const costRaw = computeCostRaw(BigInt(cumulativeBytes), this.pricePerMbRaw);
    const action = decidePolicy({ balanceRaw, costRaw, pricePerMbRaw: this.pricePerMbRaw });

    if (action.kind === "suspend") {
      this.logger(`🚨 [POLICY ENFORCER] Suspendiendo eSIM (canal agotado): ${action.reason}`);
      await this.provider.suspend(this.session.iccid);
    } else {
      this.logger(`✅ [POLICY ENFORCER] Consumo dentro del saldo del canal. Sin suspensión.`);
    }

    if (action.kind === "noop" && voucher.kind === "signed") {
      this.meter.creditPaidQuota(cumulativeBytes);
    }

    return { meterStatus: this.meter.getStatus(), actionApplied: action, voucher };
  }

  /**
   * Registra una ráfaga de tráfico en el medidor, pide el vale acumulativo
   * al agente de pagos y ejecuta la evaluación de políticas contra el
   * depósito del canal en Stellar y la eSIM. La cuota del medidor solo se
   * acredita si el agente firmó (o reusó) un vale que la cubra.
   */
  public async processTraffic(bytesTransferred: number): Promise<MeterRunResult> {
    // 1. Registrar tráfico en el medidor local
    const { cumulativeBytes } = this.meter.recordTraffic(bytesTransferred);

    // 2. Pedir el vale acumulativo que cubre el consumo medido (POST /vouchers)
    const voucher = await this.requestVoucher(cumulativeBytes);

    // 3. Consultar el depósito del canal de Stellar y evaluar la política
    const balanceRaw = await this.balancePort.getChannelBalance(this.session.channelId);
    const costRaw = computeCostRaw(BigInt(cumulativeBytes), this.pricePerMbRaw);
    const action = decidePolicy({ balanceRaw, costRaw, pricePerMbRaw: this.pricePerMbRaw });

    // 4. Aplicar los efectos secundarios en la eSIM si corresponde y sincronizar la cuota
    if (action.kind === "suspend") {
      this.logger(`🚨 [POLICY ENFORCER] Suspendiendo eSIM (canal agotado): ${action.reason}`);
      await this.provider.suspend(this.session.iccid);
    } else {
      this.logger(`✅ [POLICY ENFORCER] Tráfico dentro del saldo. Sin cambios en la eSIM.`);
    }
    if (action.kind === "noop" && voucher.kind === "signed") {
      this.meter.creditPaidQuota(cumulativeBytes);
    }

    return { meterStatus: this.meter.getStatus(), actionApplied: action, voucher };
  }

  public getMeter(): NetworkDataMeter {
    return this.meter;
  }
}