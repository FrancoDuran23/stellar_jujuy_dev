// Reconciliation job (connectivity layer, docs/citrus-mobile-spec.md v2 §7 R13):
// every classic tick compares what the trip CHARGED the user against what the
// wallet FUNDED and what the provider still reports in the wallet.
//
// The provider reports lifetime consumption (`chargedMicroUsd`), and the trip's
// own bill is `charged − baseline` (the value read when the trip started, R5).
// Two reconciliations happen here, both diagnostic only — the differences are
// EXPECTED (provider billing latency, rounding, the markup) and reconciliation
// must never throw nor influence billing:
//
//   tripChargedMicroUsd = max(0, chargedMicroUsd − chargedBaselineMicroUsd)
//   expectedWalletMicroUsd = max(0, fundedMicroUsd − tripChargedMicroUsd)
//   driftMicroUsd = walletMicroUsd − expectedWalletMicroUsd   (model vs provider)
//
// R13 removed the carrier/bytes comparison entirely: the provider never reports
// bytes (SimUsage has no `mb`), so this job no longer converts MB → bytes.

import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";

export const RECONCILIATION_INTERVAL_MS_DEFAULT = 60_000;

export type Logger = (line: unknown) => void;

export type ReconciliationDeps = {
  provider: ConnectivityProvider;
  logger?: Logger;
};

export type ReconciliationResult = {
  /** Provider-reported lifetime charged, micro-USD. */
  chargedMicroUsd: bigint;
  /** The trip baseline discount (R5), micro-USD. */
  baselineMicroUsd: bigint;
  /** This trip's bill = charged − baseline (guard ≥ 0), micro-USD. */
  tripChargedMicroUsd: bigint;
  /** Prepaid wallet funded this trip, micro-USD. */
  fundedMicroUsd: bigint;
  /** Provider-reported remaining wallet, micro-USD. */
  walletMicroUsd: bigint;
  /** Model expectation: funded − tripCharged (guard ≥ 0), micro-USD. */
  expectedWalletMicroUsd: bigint;
  /** walletMicroUsd − expectedWalletMicroUsd: diagnostic only, never billed. */
  driftMicroUsd: bigint;
};

/** Reads provider usage, refreshes `chargingChargedMicroUsd`, and logs the
 * trip-charged vs funded-wallet reconciliation + the provider-wallet drift.
 * Never throws on provider/network errors — it catches, logs a warning, and
 * recomputes from the values already persisted on the session. */
export async function runReconciliation(
  session: ConnectivitySession,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const log = deps.logger ?? ((line: unknown) => console.log(JSON.stringify(line)));
  let chargedMicroUsd = session.chargedMicroUsd;
  let walletMicroUsd = 0n;
  let status: string | undefined;
  try {
    const usage = await deps.provider.getUsage(session.iccid);
    chargedMicroUsd = usage.chargedMicroUsd;
    walletMicroUsd = usage.walletMicroUsd;
    status = usage.status;
    session.chargedMicroUsd = chargedMicroUsd;
  } catch (error) {
    log({
      level: "warn",
      reason: "reconciliation_usage_unavailable",
      sessionId: session.id,
      iccid: session.iccid,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const baselineMicroUsd = session.chargedBaselineMicroUsd;
  const tripChargedMicroUsd = chargedMicroUsd > baselineMicroUsd
    ? chargedMicroUsd - baselineMicroUsd
    : 0n;
  const fundedMicroUsd = session.fundedMicroUsd;
  const expectedWalletMicroUsd = fundedMicroUsd > tripChargedMicroUsd
    ? fundedMicroUsd - tripChargedMicroUsd
    : 0n;
  const driftMicroUsd = walletMicroUsd - expectedWalletMicroUsd;

  log({
    level: "info",
    reason: "reconciliation_diff",
    sessionId: session.id,
    iccid: session.iccid,
    simstatus: status,
    chargedMicroUsd: chargedMicroUsd.toString(),
    baselineMicroUsd: baselineMicroUsd.toString(),
    tripChargedMicroUsd: tripChargedMicroUsd.toString(),
    fundedMicroUsd: fundedMicroUsd.toString(),
    walletMicroUsd: walletMicroUsd.toString(),
    expectedWalletMicroUsd: expectedWalletMicroUsd.toString(),
    driftMicroUsd: driftMicroUsd.toString(),
    note:
      "Cargado del viaje vs fondeado de la wallet, y deriva modelo-vs-proveedor; se loguea, nunca se factura.",
  });

  return {
    chargedMicroUsd,
    baselineMicroUsd,
    tripChargedMicroUsd,
    fundedMicroUsd,
    walletMicroUsd,
    expectedWalletMicroUsd,
    driftMicroUsd,
  };
}

/** Wraps `runReconciliation` on a timer. Returns a stop function for cleanup.
 * A single run failing is already contained by `runReconciliation`; the loop
 * itself must never die. */
export function startReconciliationLoop(
  session: ConnectivitySession,
  deps: ReconciliationDeps,
  intervalMs: number = RECONCILIATION_INTERVAL_MS_DEFAULT,
): () => void {
  const timer = setInterval(() => {
    void runReconciliation(session, deps);
  }, intervalMs);
  return () => clearInterval(timer);
}