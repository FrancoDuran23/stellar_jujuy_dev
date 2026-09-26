// Usage loop (docs/citrus-mobile-spec.md v2 §7 R6/R7/R8): the ONLY consumption
// source in Citrus mode. Every `USAGE_POLL_INTERVAL_MS` it reads
// `getUsage(iccid)`, derives the trip's `chargedSession` against the stored
// baseline, converts to equivalent bytes (§6.2, monotonic), and pushes them
// through `IntegratedMeterService.processCumulative` (the voucher flow).
//
// The unpaid-cap net (user's amendment to R8): `unpaidRaw` = expected amount
// for the current equivalent bytes minus the last SIGNED cumulative amount.
// Once it exceeds `CITRUS_UNPAID_CAP_BPS` (default 1000 bps = 10% of the
// deposit), the loop suspends the eSIM; once a signed voucher covers the
// accumulation again, it resumes. A non-retryable voucher rejection is handled
// inside `processCumulative` (policy suspend) — see meter-service.
//
// While the SessionCloser is shutting down (`row.closing`) or a defund is
// settling, the loop reads nothing and never touches the eSIM: the trip is
// leaving.

import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { EsimStore } from "../persistence/esim-record.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";
import type { IntegratedMeterService } from "../meter/meter-service.ts";
import type { ChannelBalancePort } from "../services/PolicyEnforcer.ts";
import { equivalentBytes } from "../shared/usage-math.ts";
import { computeExpectedAmountRaw } from "../shared/money.ts";

export type UsageLoopOptions = {
  provider: ConnectivityProvider;
  esimStore: EsimStore;
  meter: IntegratedMeterService;
  balancePort: ChannelBalancePort;
  /** Env vars (spec §6.1). */
  markupBps: number;
  usdcUsdRateBps: number;
  pricePerMbRaw: bigint;
  /** `PRICE_PER_MIB_RAW` — the voucher's own price, for unpaidRaw. */
  voucherPricePerMibRaw: bigint;
  /** Unpaid-cap in basis points of the deposit (CITRUS_UNPAID_CAP_BPS). */
  unpaidCapBps: number;
  pollIntervalMs: number;
  session?: ConnectivitySession;
  logger?: (line: unknown) => void;
  now?: () => Date;
};

export type UsageReadingResult = {
  skipped: "closing" | "defund_pending" | "no_row" | null;
  chargedMicroUsd: bigint;
  equivalentBytes: bigint;
  voucherCumulativeAmountRaw: bigint;
  suspendedByUnpaid: boolean;
};

export class UsageLoop {
  private readonly provider: ConnectivityProvider;
  private readonly esimStore: EsimStore;
  private readonly meter: IntegratedMeterService;
  private readonly balancePort: ChannelBalancePort;
  private readonly markupBps: number;
  private readonly usdcUsdRateBps: number;
  private readonly pricePerMbRaw: bigint;
  private readonly voucherPricePerMibRaw: bigint;
  private readonly unpaidCapBps: number;
  private readonly pollIntervalMs: number;
  private readonly session?: ConnectivitySession;
  private readonly logger: (line: unknown) => void;
  private readonly now: () => Date;
  /** Per-iccid last-seen equivalent bytes (monotonicity, R6). */
  private readonly lastEqBytes = new Map<string, bigint>();
  /** Per-iccid last signed cumulative amount (rebuilt on the first signed
   * reading after a restart — the voucher covers the whole accumulation). */
  private readonly lastSignedRaw = new Map<string, bigint>();
  /** Per-iccid unpaid-cap suspension flag. */
  private readonly suspendedByUnpaid = new Map<string, boolean>();

  constructor(options: UsageLoopOptions) {
    this.provider = options.provider;
    this.esimStore = options.esimStore;
    this.meter = options.meter;
    this.balancePort = options.balancePort;
    this.markupBps = options.markupBps;
    this.usdcUsdRateBps = options.usdcUsdRateBps;
    this.pricePerMbRaw = options.pricePerMbRaw;
    this.voucherPricePerMibRaw = options.voucherPricePerMibRaw;
    this.unpaidCapBps = options.unpaidCapBps;
    this.pollIntervalMs = options.pollIntervalMs;
    this.session = options.session;
    this.logger = options.logger ?? ((line) => console.log(JSON.stringify(line)));
    this.now = options.now ?? (() => new Date());
  }

  /** One reading for one iccid. NEVER throws on provider/network errors — the
   * loop logs and returns, and the next tick retries (R6: reconcile-only). */
  async runOnce(iccid: string): Promise<UsageReadingResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) {
      this.logger({ level: "warn", reason: "usage_no_row", iccid });
      return { skipped: "no_row", chargedMicroUsd: 0n, equivalentBytes: 0n, voucherCumulativeAmountRaw: 0n, suspendedByUnpaid: false };
    }
    if (row.closing !== null) {
      return { skipped: "closing", chargedMicroUsd: 0n, equivalentBytes: 0n, voucherCumulativeAmountRaw: 0n, suspendedByUnpaid: false };
    }
    if (row.defundPending) {
      return { skipped: "defund_pending", chargedMicroUsd: 0n, equivalentBytes: 0n, voucherCumulativeAmountRaw: 0n, suspendedByUnpaid: false };
    }

    try {
      const usage = await this.provider.getUsage(iccid);

      const baseline = row.chargedBaselineMicroUsd;
      const charged = usage.chargedMicroUsd - baseline < 0n ? 0n : usage.chargedMicroUsd - baseline;
      const eqBytesRaw = equivalentBytes(charged, this.markupBps, this.usdcUsdRateBps, this.pricePerMbRaw);
      const seen = this.lastEqBytes.get(iccid) ?? 0n;
      const eqBytes = eqBytesRaw > seen ? eqBytesRaw : seen; // R6 monotónico
      this.lastEqBytes.set(iccid, eqBytes);

      if (this.session !== undefined) {
        this.session.chargedMicroUsd = usage.chargedMicroUsd;
        this.session.chargedBaselineMicroUsd = baseline;
        this.session.fundedMicroUsd = row.fundedMicroUsd;
      }

      const depositRaw = await this.balancePort.getChannelBalance(row.channelId === "" ? "" : row.channelId);
      const capRaw = (depositRaw * BigInt(this.unpaidCapBps)) / 10_000n;

      const result = await this.meter.processCumulative(Number(eqBytes));
      let lastSigned = this.lastSignedRaw.get(iccid) ?? 0n;
      if (result.voucher.kind === "signed") {
        lastSigned = BigInt(result.voucher.envelope.voucher.cumulativeAmount);
        this.lastSignedRaw.set(iccid, lastSigned);
      }

      const unpaidRaw = computeExpectedAmountRaw(eqBytes, this.voucherPricePerMibRaw) - lastSigned;
      const unpaidActive = unpaidRaw > capRaw && result.voucher.kind !== "signed";

      const wasSuspended = this.suspendedByUnpaid.get(iccid) ?? false;
      if (unpaidActive && !wasSuspended) {
        this.logger({
          level: "warn",
          reason: "unpaid_cap_exceeded_suspend",
          iccid,
          unpaidRaw: unpaidRaw.toString(),
          capRaw: capRaw.toString(),
        });
        await this.provider.suspend(iccid);
        this.suspendedByUnpaid.set(iccid, true);
      } else if (wasSuspended && !unpaidActive) {
        this.logger({ level: "info", reason: "unpaid_covered_resume", iccid });
        await this.provider.resume(iccid);
        this.suspendedByUnpaid.set(iccid, false);
      }

      return {
        skipped: null,
        chargedMicroUsd: charged,
        equivalentBytes: eqBytes,
        voucherCumulativeAmountRaw: lastSigned,
        suspendedByUnpaid: this.suspendedByUnpaid.get(iccid) ?? false,
      };
    } catch (error) {
      this.logger({
        level: "error",
        reason: "usage_reading_failed",
        iccid,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { skipped: null, chargedMicroUsd: 0n, equivalentBytes: 0n, voucherCumulativeAmountRaw: 0n, suspendedByUnpaid: this.suspendedByUnpaid.get(iccid) ?? false };
    }
  }

  /** Starts the loop; returns a stop function. One in-flight run is never
   * overlapped: a slow reading simply delays the next tick. */
  start(iccid: string): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      await this.runOnce(iccid);
      if (stopped) return;
      timer = setTimeout(() => void tick().catch(() => {}), this.pollIntervalMs);
      timer.unref?.();
    };
    void tick().catch(() => {});
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }
}