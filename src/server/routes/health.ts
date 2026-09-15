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
export function createReadyRoute<T>(boot: Pick<FailClosedBoot<T>, "getState">): RequestHandler {
  return (_req, res) => {
    const state = boot.getState();
    const checkedAt = new Date().toISOString();
    if (state.status === "ready") {
      res.status(200).json({ status: "ready", stage: 1, checkedAt });
      return;
    }
    res
      .status(503)
      .json({ status: "unavailable", reason: state.reason, detail: state.detail, stage: 1, checkedAt });
  };
}
