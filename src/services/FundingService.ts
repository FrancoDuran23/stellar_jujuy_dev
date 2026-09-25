// FundingService (docs/citrus-mobile-spec.md v2 §7 R5): tops the eSIM wallet
// up to `maxWalletCents` (I2), once at channel open and again on a channel
// top-up — never in tranches.
//
// Amount: the gap to `maxWalletCents` minus what was ALREADY funded this trip
// (`row.fundedMicroUsd`), in whole cents. Invariant I2: funded × MARKUP ≤
// deposit, in every branch below.
//
// Crash/timeout handling (the spec's "en lugar de reintentar"): the fund is
// NEVER blindly retried. Before `POST /fund` the row persists `pendingFund`
// (with the wallet value read just before); after a timeout or restart,
// `ensureFunded` reconciles with `getUsage()` instead — if the wallet grew by
// the requested cents, the fund landed and `fundedMicroUsd` is credited; if
// not, it did not and the gap is re-attempted fresh. A definitive rejection
// (400/401/404/409) clears the pending intent and rethrows — the intent is
// not durable because the provider refused it outright.
//
// While the SessionCloser is shutting the trip down (`row.closing`) or a
// defund is settling, this service does nothing (the defund blocks topUp at
// Citrus anyway, and re-funding a closing trip would be lost).

import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { EsimStore } from "../persistence/esim-record.ts";
import type { ChannelBalancePort } from "./PolicyEnforcer.ts";
import { maxWalletCents } from "../shared/usage-math.ts";
import { CitrusApiError } from "../shared/citrus-errors.ts";

export const MICRO_USD_PER_CENT = 10_000n;

export type FundingServiceOptions = {
  provider: ConnectivityProvider;
  esimStore: EsimStore;
  /** Channel cumulative deposit (`getChannelBalance`), raw units. */
  balancePort: ChannelBalancePort;
  markupsBps: number;
  usdcUsdRateBps: number;
  logger?: (line: unknown) => void;
};

export type EnsureFundedResult =
  | { funded: true; amountCents: number }
  | { funded: false; reason: "already_funded" | "closing" | "defund_pending" | "terminated" | "no_row" };

export class FundingService {
  private readonly provider: ConnectivityProvider;
  private readonly esimStore: EsimStore;
  private readonly balancePort: ChannelBalancePort;
  private readonly markupBps: number;
  private readonly usdcUsdRateBps: number;
  private readonly logger: (line: unknown) => void;

  constructor(options: FundingServiceOptions) {
    this.provider = options.provider;
    this.esimStore = options.esimStore;
    this.balancePort = options.balancePort;
    this.markupBps = options.markupsBps;
    this.usdcUsdRateBps = options.usdcUsdRateBps;
    this.logger = options.logger ?? ((line) => console.log(JSON.stringify(line)));
  }

  /**
   * Ensures the wallet holds `maxWalletCents` worth of funding for the
   * channel's current deposit. Idempotent: a second call after a successful
   * run has gap ≤ 0 and does nothing. See the module doc for crash recovery.
   */
  async ensureFunded(input: { iccid: string; userRef: string; channelId: string }): Promise<EnsureFundedResult> {
    const { iccid, userRef, channelId } = input;
    const row = this.esimStore.get(iccid);
    if (row === undefined) {
      return { funded: false, reason: "no_row" };
    }

    if (row.closing !== null) return { funded: false, reason: "closing" };
    if (row.defundPending) return { funded: false, reason: "defund_pending" };
    if (row.status === "terminated") return { funded: false, reason: "terminated" };

    const depositRaw = await this.balancePort.getChannelBalance(channelId);
    const maxCents = maxWalletCents(depositRaw, this.usdcUsdRateBps, this.markupBps);

    const usage = await this.provider.getUsage(iccid);
    const walletCents = Number(usage.walletMicroUsd / MICRO_USD_PER_CENT);

    let fundedCents = Number(row.fundedMicroUsd / MICRO_USD_PER_CENT);

    // --- Reconcile a persisted, unconfirmed fund (crash/timeout restart) ---
    if (row.pendingFund !== null) {
      const pending = row.pendingFund;
      const landed = walletCents >= pending.walletBeforeCents + pending.amountCents - 6; // ≤5¢ rounding, C5
      if (landed) {
        fundedCents += pending.amountCents;
        await this.esimStore.update(iccid, (r) => ({
          ...(r ?? row),
          channelId,
          fundedMicroUsd: BigInt(fundedCents) * MICRO_USD_PER_CENT,
          pendingFund: null,
          updatedAt: new Date().toISOString(),
        }));
        this.logConfirm(iccid, pending.amountCents, "reconciled");
      } else {
        // Did NOT land: drop the stale intent; the gap is recomputed and a
        // fresh attempt happens below (safe — the wallet shows the truth).
        await this.esimStore.update(iccid, (r) => ({
          ...(r ?? row),
          pendingFund: null,
          updatedAt: new Date().toISOString(),
        }));
        this.logger({
          level: "warn",
          reason: "fund_intent_dropped",
          iccid,
          amountCents: pending.amountCents,
          note: "pendingFund sin confirmar se reconcilió contra el wallet y no aterrizó",
        });
      }
    }

    // --- Gap to the top ---
    const gap = maxCents - fundedCents;
    if (gap <= 0) {
      return { funded: false, reason: "already_funded" };
    }

    // Persist the intent BEFORE the call (R5), with the wallet-before value.
    await this.esimStore.update(iccid, (r) => {
      const base = r ?? row;
      return {
        ...base,
        channelId,
        pendingFund: { amountCents: gap, walletBeforeCents: walletCents, requestedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
    });

    try {
      await this.provider.topUp(iccid, gap);
    } catch (error) {
      // Definitive rejection: clear the durable intent (the provider refused),
      // rethrow so the caller alerts. Timeout/transport/402 keep pendingFund
      // as the durable reconciliation source for the next run.
      if (error instanceof CitrusApiError && !error.retryable) {
        await this.esimStore.update(iccid, (r) => ({
          ...(r ?? row),
          pendingFund: null,
          updatedAt: new Date().toISOString(),
        }));
      }
      throw error;
    }

    // Confirmed: credit the funded total (I2).
    await this.esimStore.update(iccid, (r) => ({
      ...(r ?? row),
      channelId,
      fundedMicroUsd: BigInt(fundedCents + gap) * MICRO_USD_PER_CENT,
      pendingFund: null,
      updatedAt: new Date().toISOString(),
    }));
    this.logConfirm(iccid, gap, "confirmed");
    return { funded: true, amountCents: gap };
  }

  private logConfirm(iccid: string, amountCents: number, source: "confirmed" | "reconciled"): void {
    this.logger({
      level: "info",
      reason: "wallet_funded",
      iccid,
      amountCents,
      source,
    });
  }
}

export type { ChannelBalancePort };