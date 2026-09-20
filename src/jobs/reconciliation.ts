// Reconciliation job (connectivity layer): every 60s reads the usage Telnyx
// reports per SIM, converts MB → bytes EXPLICITLY, and logs the difference
// against the gateway's own meteredBytes.
//
// The difference is EXPECTED, never a bug (carriers measure differently and
// with latency): reconciliation is diagnostic only and must never throw nor
// influence billing. Billing always uses `meteredBytes`
// (docs/telnyx-wireless-integracion.md §1 and §5.7).

import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";
import { BYTES_PER_MB } from "../services/PolicyEnforcer.ts";

export const RECONCILIATION_INTERVAL_MS_DEFAULT = 60_000;

export type Logger = (line: unknown) => void;

/** The ONLY place MB → bytes conversion happens. Telnyx reports decimal MB,
 * so 1 MB = 1 000 000 bytes (`BYTES_PER_MB`, not 1048576). Returns whole
 * bytes; guards against NaN/negative input instead of emitting garbage. */
export function mbToBytes(mb: number): bigint {
  if (!Number.isFinite(mb) || mb < 0) {
    throw new RangeError(`mbToBytes: MB debe ser un número finito no negativo, recibí ${mb}`);
  }
  return BigInt(Math.round(mb * 1_000_000));
}

export type ReconciliationDeps = {
  provider: ConnectivityProvider;
  logger?: Logger;
};

export type ReconciliationResult = {
  carrierBytes: bigint;
  meteredBytes: bigint;
  diffBytes: bigint;
};

/** Reads provider usage, updates `session.carrierBytes`, and logs the diff.
 * Never throws on provider/network errors — it catches, logs a warning, and
 * leaves `carrierBytes` untouched; the diff is informational. */
export async function runReconciliation(
  session: ConnectivitySession,
  deps: ReconciliationDeps,
): Promise<ReconciliationResult> {
  const log = deps.logger ?? ((line: unknown) => console.log(JSON.stringify(line)));
  let mb: number;
  let status: string;
  try {
    const usage = await deps.provider.getUsage(session.simCardId);
    mb = usage.mb;
    status = usage.status;
  } catch (error) {
    log({
      level: "warn",
      reason: "reconciliation_usage_unavailable",
      sessionId: session.id,
      simCardId: session.simCardId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      carrierBytes: session.carrierBytes,
      meteredBytes: session.meteredBytes,
      diffBytes: session.meteredBytes - session.carrierBytes,
    };
  }

  const carrierBytes = mbToBytes(mb);
  session.carrierBytes = carrierBytes;
  const meteredBytes = session.meteredBytes;
  const diffBytes = meteredBytes - carrierBytes;

  log({
    level: "info",
    reason: "reconciliation_diff",
    sessionId: session.id,
    simCardId: session.simCardId,
    carrierStatus: status,
    carrierMb: mb,
    carrierBytes: carrierBytes.toString(),
    meteredBytes: meteredBytes.toString(),
    diffBytes: diffBytes.toString(),
    note:
      "Diferencia esperada entre el consumo del carrier y el del gateway; se loguea, nunca se factura.",
  });

  return { carrierBytes, meteredBytes, diffBytes };
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