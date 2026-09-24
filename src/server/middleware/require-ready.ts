// Fail-closed payment-route middleware (design 4.5; spec FC-R5, FC-R6, FC-R8,
// T4.1). Mounted ONLY on payment routes — `/health` and `/ready` must never
// go through this middleware (FC-R6), so app.ts wires it per-route, not as
// a blanket `app.use()`.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { toM2Reason, type BuildResult, type FailClosedBoot } from "../../config/boot.ts";
import { unsignedResponse } from "../../shared/http.ts";

/**
 * When the instance is not ready, this re-arms it (subject to the boot's own
 * throttle, FC-R8) and — if that same attempt succeeds — serves the request
 * that triggered it, matching the spec's "recuperación sin reinicio"
 * scenario: the request that arrives once the retry interval has elapsed is
 * the one that gets served, not the next one.
 */
export function requireReady<T>(
  boot: Pick<FailClosedBoot<T>, "getState" | "ensureReady">,
): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction) => {
    let state: BuildResult<T> = boot.getState();
    if (state.status !== "ready") {
      state = await boot.ensureReady();
    }
    if (state.status === "ready") {
      next();
      return;
    }
    const response = unsignedResponse(toM2Reason(state.reason), {
      sessionId: null,
      meterReadingId: null,
      detail: state.detail,
    });
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.send(await response.text());
  };
}
