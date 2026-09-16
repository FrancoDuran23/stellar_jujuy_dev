// `GET /health` and `GET /ready` (design 4.5; spec FC-R6, FC-R7, T4.1).
// Neither route is gated by `requireReady` — a broken payment instance must
// never make these two unreachable, or the fail-closed diagnosis story
// (§11: "un 503 se diagnostica en diez segundos") falls apart.

import type { RequestHandler } from "express";
import type { FailClosedBoot } from "../../config/boot.ts";

/** Always 200 while the process is alive — no readiness check involved. */
export function createHealthRoute(): RequestHandler {
  return (_req, res) => {
    res.status(200).json({ status: "alive" });
  };
}

/**
 * Reports the payment instance's real state, including a human-readable
 * `reason`/`detail` (CF-R3: never a secret, only variable names and
 * diagnosis). `curl -f /ready` doubles as a scriptable checklist gate
 * (design 4.5) since it uses the instance's actual HTTP status, not just the
 * JSON body.
 */
export type ReadyExtraResult = {
  /** Merged into the JSON body regardless of the final HTTP status. */
  fields?: Record<string, unknown>;
  /**
   * Review finding 6 (Lote F): lets a caller with additional readiness
   * criteria (stage 2's channel instance + close-monitor) force the overall
   * `/ready` response to `503` even though the PRIMARY boot is itself
   * `ready` — before this, `/ready` returned `200` whenever stage 1 alone
   * was healthy, even if `CHANNEL_CONTRACT` was configured and the channel
   * instance was unavailable or its close-monitor was not running.
   */
  unavailable?: { reason: string; detail: string };
};

/**
 * `extra` (WU7): an optional thunk returning additional fields to merge into
 * the JSON body — `server/app.ts` uses it to add `stage: 2`, the channel id,
 * and the close-monitor's last known state/error once stage 2 is
 * configured, without this generic route needing to know anything about
 * channels. Never called for the `unavailable` branch of the PRIMARY boot
 * (a broken base instance is reported on its own terms first); stage-2
 * detail (and its own `unavailable` override, review finding 6) only ever
 * applies once the primary instance is otherwise `ready`.
 */
export function createReadyRoute<T>(
  boot: Pick<FailClosedBoot<T>, "getState">,
  extra?: () => ReadyExtraResult,
): RequestHandler {
  return (_req, res) => {
    const state = boot.getState();
    const checkedAt = new Date().toISOString();
    if (state.status === "ready") {
      const extraResult = extra ? extra() : undefined;
      if (extraResult?.unavailable !== undefined) {
        res.status(503).json({
          status: "unavailable",
          reason: extraResult.unavailable.reason,
          detail: extraResult.unavailable.detail,
          stage: 1,
          checkedAt,
          ...(extraResult.fields ?? {}),
        });
        return;
      }
      res.status(200).json({ status: "ready", stage: 1, checkedAt, ...(extraResult?.fields ?? {}) });
      return;
    }
    res
      .status(503)
      .json({ status: "unavailable", reason: state.reason, detail: state.detail, stage: 1, checkedAt });
  };
}
