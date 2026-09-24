// SessionCloser (docs/citrus-mobile-spec.md v2 §7 R9): drives the END of a trip
// for ONE eSIM through the persisted closing walk, never touching the agent or
// the charge/canal servers' internals — the close port it consumes is the
// EXISTING `channelService.closeChannel` (unmodified, spec §12.7).
//
// Walk (persisted in esim-record as `row.closing.step`, so a crash resumes the
// exact step — each step advances the marker only after its side effect):
//   defund_solicitado → defund_liquidado → ultimo_vale_firmado → canal_cerrado
//
//  1. `refundUnused(iccid)` (defund): pauses data; `defundPending` blocks
//     topUp/resume. The 202's settlement metadata is persisted by
//     CitrusProvider itself (in fake mode the provider keeps its own state and
//     esim-record's `defund` stays null — the polling fallback below covers
//     the fake too).
//  2. Wait for the settlement: webhooks (`esim.defunded` marked by
//     CitrusWebhookHandler, `defund.settledAt !== null`) OR the polling
//     fallback (spec §12.3) — `getUsage()` shows `walletMicroUsd === 0n`
//     continuously for `stableWindowMs`.
//  3. Final consumption = charged read AFTER settlement − baseline; request
//     the LAST voucher for it through the trip's `IntegratedMeterService`
//     (the same `processCumulative` the usage loop uses — R7/R9 step 4); the
//     agent delivers it to the server, which records it as the highest
//     accepted voucher.
//  4. `closeChannel(channelId)`: the server settles and refunds the rest.
//     The eSIM stays installed and goes `idle` (D8); `fundedMicroUsd` and
//     `chargedBaselineMicroUsd` reset so the NEXT trip starts clean. The
//     defund record is kept (audit trail).
//
// `runOnce(iccid)` NEVER throws: every provider/close failure resolves to a
// step result the CLI/orchestrator can retry on the next run (same stance as
// the usage loop).

import type { ConnectivityProvider, SimUsage } from "../providers/connectivity/ConnectivityProvider.ts";
import type { EsimStore, EsimRecordRow, EsimClosingStep } from "../persistence/esim-record.ts";
import type { IntegratedMeterService, VoucherRequestResult } from "../meter/meter-service.ts";
import type { CloseOutcome } from "../server/channel-service.ts";
import { equivalentBytes } from "../shared/usage-math.ts";

export type SessionCloseResult =
  | { step: null; skipped: "no_row" | "not_closing" }
  | { step: "defund_solicitado"; detail: string }
  | { step: "defund_liquidado"; settled: false; detail: string }
  | { step: "ultimo_vale_firmado"; voucherKind: VoucherRequestResult["kind"]; detail: string }
  | { step: "canal_cerrado"; closeKind: CloseOutcome["kind"]; detail: string }
  | { step: "done"; closeKind: CloseOutcome["kind"]; detail: string };

export type SessionCloserOptions = {
  provider: ConnectivityProvider;
  esimStore: EsimStore;
  /** The trip's IntegratedMeterService: `processCumulative` requests the FINAL
   * voucher for the post-settlement consumption through the same voucher flow
   * the usage loop uses (R9 step 4). Its session must carry the trip's iccid +
   * channelId. */
  meter: IntegratedMeterService;
  /** The server's existing channel close port, consumed verbatim (R9 step 5,
   * spec §12.7). Never called with a channelId the trip never had. */
  closeChannel: (channelId: string) => Promise<CloseOutcome>;
  markupBps: number;
  usdcUsdRateBps: number;
  pricePerMbRaw: bigint;
  /** Defund settle-poll cadence (fallback when webhooks are not mounted). */
  pollIntervalMs?: number;
  /** CITRUS_DEFUND_STABLE_WINDOW_MS — `walletMicroUsd === 0n` sustained this
   * long is taken as "defund settled" when no `esim.defunded` webhook arrived
   * (spec §12.3: el fin del defund no está documentado en la API). */
  stableWindowMs?: number;
  logger?: (line: unknown) => void;
  now?: () => Date;
};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionCloser {
  private readonly provider: ConnectivityProvider;
  private readonly esimStore: EsimStore;
  private readonly meter: IntegratedMeterService;
  private readonly closeChannel: (channelId: string) => Promise<CloseOutcome>;
  private readonly markupBps: number;
  private readonly usdcUsdRateBps: number;
  private readonly pricePerMbRaw: bigint;
  private readonly stableWindowMs: number;
  private readonly logger: (line: unknown) => void;
  private readonly now: () => Date;
  /** Per-iccid first instant the wallet read 0 without a webhook settlement —
   * the polling fallback's stable-window accumulator. */
  private readonly walletZeroSince = new Map<string, number>();

  constructor(options: SessionCloserOptions) {
    this.provider = options.provider;
    this.esimStore = options.esimStore;
    this.meter = options.meter;
    this.closeChannel = options.closeChannel;
    this.markupBps = options.markupBps;
    this.usdcUsdRateBps = options.usdcUsdRateBps;
    this.pricePerMbRaw = options.pricePerMbRaw;
    this.stableWindowMs = options.stableWindowMs ?? 300_000;
    this.logger = options.logger ?? ((line) => console.log(JSON.stringify(line)));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Starts (or resumes) the closing walk for one eSIM. Idempotent: a trip
   * already closing is not restarted from step zero; a pending defund (crash
   * after `refundUnused` returned) resumes directly at `defund_liquidado`.
   * Never throws.
   */
  async beginClose(iccid: string): Promise<{ started: boolean; reason: "no_row" | "already_closing" | "ok" }> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { started: false, reason: "no_row" };
    if (row.closing !== null) return { started: false, reason: "already_closing" };
    // A defund already issued by a previous walk (crash before the advance):
    // continue from the wait, not from a duplicate defund request.
    const step: EsimClosingStep = row.defundPending ? "defund_liquidado" : "defund_solicitado";
    await this.esimStore.update(iccid, (r) => ({
      ...(r ?? row),
      closing: { step, startedAt: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }));
    this.logger({ level: "info", reason: "close_walk_started", iccid, step });
    return { started: true, reason: "ok" };
  }

  /**
   * Advances the closing walk ONE step. Never throws: a provider failure
   * leaves the step in place for the next run to retry (the marker only moves
   * after each side effect completes).
   */
  async runOnce(iccid: string): Promise<SessionCloseResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { step: null, skipped: "no_row" };
    if (row.closing === null) return { step: null, skipped: "not_closing" };

    switch (row.closing.step) {
      case "defund_solicitado":
        return this.stepSolicitar(row);
      case "defund_liquidado":
        return this.stepEsperarLiquidacion(iccid);
      case "ultimo_vale_firmado":
        return this.stepUltimoVale(iccid);
      case "canal_cerrado":
        return this.stepCerrar(iccid);
    }
  }

  private async stepSolicitar(row: EsimRecordRow): Promise<SessionCloseResult> {
    if (row.defund === null) {
      try {
        await this.provider.refundUnused(row.iccid);
      } catch (error) {
        this.logger({
          level: "error",
          reason: "defund_request_failed",
          iccid: row.iccid,
          detail: messageOf(error),
        });
        return { step: "defund_solicitado", detail: `defund falló, se reintenta: ${messageOf(error)}` };
      }
    }
    // `refundUnused` persisted the 202 metadata + defundPending (real provider);
    // advance the marker so a crash mid-request cannot re-issue the defund.
    await this.esimStore.update(row.iccid, (r) => ({
      ...(r ?? row),
      closing: { step: "defund_liquidado", startedAt: r?.closing?.startedAt ?? this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }));
    return { step: "defund_liquidado", settled: false, detail: "defund solicitado (202), esperando liquidación" };
  }

  private async stepEsperarLiquidacion(iccid: string): Promise<SessionCloseResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { step: null, skipped: "no_row" };

    if (row.defund !== null && row.defund.settledAt !== null) {
      this.logger({
        level: "info",
        reason: "defund_settled",
        iccid,
        via: "webhook",
        returnedMicroUsd: row.defund.returnedMicroUsd?.toString() ?? null,
      });
      return this.advanceAfterSettlement(iccid, "webhook");
    }

    let usage: SimUsage;
    try {
      usage = await this.provider.getUsage(iccid);
    } catch (error) {
      this.logger({ level: "warn", reason: "settle_poll_failed", iccid, detail: messageOf(error) });
      return { step: "defund_liquidado", settled: false, detail: `lectura de liquidación falló: ${messageOf(error)}` };
    }

    if (usage.walletMicroUsd === 0n) {
      const firstZero = this.walletZeroSince.get(iccid) ?? this.now().getTime();
      this.walletZeroSince.set(iccid, firstZero);
      if (this.now().getTime() - firstZero >= this.stableWindowMs) {
        this.logger({ level: "info", reason: "defund_settled", iccid, via: "poll" });
        return this.advanceAfterSettlement(iccid, "poll");
      }
      return {
        step: "defund_liquidado",
        settled: false,
        detail: `esperando asentamiento del defund (wallet en 0, ventana estable de ${this.stableWindowMs}ms)`,
      };
    }
    this.walletZeroSince.delete(iccid);
    return {
      step: "defund_liquidado",
      settled: false,
      detail: `esperando asentamiento del defund (wallet aún ${usage.walletMicroUsd} micro-USD)`,
    };
  }

  /**
   * Settlement detected (webhook OR polling fallback): stamp the (real-provider)
   * `defund.settledAt`, move the marker to the final voucher step, and perform
   * it right away.
   */
  private async advanceAfterSettlement(iccid: string, _via: "webhook" | "poll"): Promise<SessionCloseResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { step: null, skipped: "no_row" };
    await this.esimStore.update(iccid, (r) => {
      const base = r ?? row;
      return {
        ...base,
        // Only a webhook (or caller) carrying `defund.settledAt` stamps it; the
        // fake mode keeps `defund` null and the poll path leaves it untouched.
        ...(base.defund !== null
          ? { defund: { ...base.defund, settledAt: base.defund.settledAt ?? this.now().toISOString() } }
          : {}),
        closing: { step: "ultimo_vale_firmado", startedAt: base.closing?.startedAt ?? this.now().toISOString() },
        updatedAt: this.now().toISOString(),
      };
    });
    return this.stepUltimoVale(iccid);
  }

  private async stepUltimoVale(iccid: string): Promise<SessionCloseResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { step: null, skipped: "no_row" };

    let usage: SimUsage;
    try {
      usage = await this.provider.getUsage(iccid);
    } catch (error) {
      this.logger({ level: "warn", reason: "final_usage_failed", iccid, detail: messageOf(error) });
      return { step: "ultimo_vale_firmado", voucherKind: "unavailable", detail: `lectura final falló: ${messageOf(error)}` };
    }

    const chargedSession = usage.chargedMicroUsd - row.chargedBaselineMicroUsd;
    const finalCharged = chargedSession < 0n ? 0n : chargedSession;
    const finalEqBytes = equivalentBytes(finalCharged, this.markupBps, this.usdcUsdRateBps, this.pricePerMbRaw);

    let voucher: VoucherRequestResult;
    try {
      // processCumulative never throws for the voucher request itself, but its
      // balance read can throw on an RPC failure — wrap it so the walk never
      // dies mid-step.
      const result = await this.meter.processCumulative(Number(finalEqBytes));
      voucher = result.voucher;
    } catch (error) {
      this.logger({ level: "warn", reason: "final_voucher_failed", iccid, detail: messageOf(error) });
      return { step: "ultimo_vale_firmado", voucherKind: "unavailable", detail: `último vale falló: ${messageOf(error)}` };
    }

    this.logger({
      level: "info",
      reason: "final_voucher",
      iccid,
      finalChargedMicroUsd: finalCharged.toString(),
      equivalentBytes: finalEqBytes.toString(),
      voucherKind: voucher.kind,
    });

    await this.esimStore.update(iccid, (r) => ({
      ...(r ?? row),
      closing: { step: "canal_cerrado", startedAt: r?.closing?.startedAt ?? this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }));
    return { step: "canal_cerrado", closeKind: "nothing_to_close", detail: "último vale pedido; cerrando canal" };
  }

  private async stepCerrar(iccid: string): Promise<SessionCloseResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { step: null, skipped: "no_row" };

    if (row.channelId === "") {
      // Fake/demo path (no channel ever opened): nothing to settle — the walk
      // still ends so the eSIM returns to idle.
      return this.finalize(iccid, "nothing_to_close", "sin canal (demo), cierre omitido");
    }

    const outcome = await this.closeChannel(row.channelId);
    if (outcome.kind === "closed" || outcome.kind === "closed_unverified" || outcome.kind === "nothing_to_close") {
      return this.finalize(iccid, outcome.kind, `canal cerrado (${outcome.kind})`);
    }
    // blocked/failed: keep the step so the operator retries on a later run.
    this.logger({ level: "error", reason: "channel_close_failed", iccid, outcome });
    return { step: "canal_cerrado", closeKind: outcome.kind, detail: `cierre del canal falló: ${outcome.detail}` };
  }

  private async finalize(iccid: string, closeKind: CloseOutcome["kind"], detail: string): Promise<SessionCloseResult> {
    const row = this.esimStore.get(iccid);
    if (row === undefined) return { step: null, skipped: "no_row" };
    const defundReturned = row.defund?.returnedMicroUsd ?? null;
    const fundedThisTrip = BigInt(row.fundedMicroUsd);
    await this.esimStore.update(iccid, (r) => ({
      ...(r ?? row),
      status: "idle",
      closing: null,
      defundPending: false,
      // Next trip starts a fresh baseline/funding ledger (D8: same eSIM).
      fundedMicroUsd: 0n,
      chargedBaselineMicroUsd: 0n,
      updatedAt: this.now().toISOString(),
    }));
    this.logger({
      level: "info",
      reason: "trip_closed",
      iccid,
      closeKind,
      fundedMicroUsd: fundedThisTrip.toString(),
      defundReturnedMicroUsd: defundReturned?.toString() ?? null,
    });
    return { step: "done", closeKind, detail };
  }
}