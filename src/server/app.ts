// Express app assembly for the payment server (design 4.1, 4.5; T3.2, T4.1).
// This is the only file that wires routes/middleware together; the SDK
// itself is never touched here — only through `FailClosedBoot<ChargePort>`,
// built in `config/boot.ts`.

import express, { type ErrorRequestHandler, type Express } from "express";
import type { FailClosedBoot } from "../config/boot.ts";
import type { EmitInput } from "../shared/events.ts";
import { buildUnsigned } from "../shared/messages.ts";
import { createChargeService, type ChargePort } from "./charge-service.ts";
import { createChargeRoute, type CumulativeBytesStore } from "./routes/charge.ts";
import { createHealthRoute, createReadyRoute } from "./routes/health.ts";
import { requireReady } from "./middleware/require-ready.ts";

export type CreateServerAppOptions = {
  boot: FailClosedBoot<ChargePort>;
  network: string;
  explorerBaseUrl: string;
  pricePerMibRaw: bigint;
  cumulativeBytesStore?: CumulativeBytesStore;
  /** Defaults to stdout-only `emit()`; `server/main.ts` passes the
   * webhook-enabled emitter (T4.2) when `BACKEND_EVENTS_URL` is set. */
  emit?: (input: EmitInput) => void;
};

/**
 * Reads the current `ChargePort` from `boot` on every call instead of
 * capturing one at startup, so a re-armed instance (FC-R8) is picked up
 * without re-registering the route. The `internal_error` fallback should
 * never actually trigger in practice — `requireReady` already blocks this
 * route while `boot` is not ready — but it keeps the port total and
 * side-effect-free if it ever is called out of order.
 */
function createLiveChargePort(boot: Pick<FailClosedBoot<ChargePort>, "getState">): ChargePort {
  return {
    async handle(request, params) {
      const state = boot.getState();
      if (state.status !== "ready") {
        return { kind: "failed", reason: "internal_error", detail: state.detail };
      }
      return state.instance.handle(request, params);
    },
  };
}

/**
 * Catch-all error handler (review finding, Lote D, MAJOR): without this,
 * Express 5 forwards any uncaught throw or rejected promise from a route
 * handler (`createChargeRoute`'s async function included) to its own default
 * error page — HTML, with a stack trace containing absolute file paths. This
 * mirrors `agent/app.ts`'s `jsonParseErrorHandler` (same "never leak a stack,
 * always answer JSON" rule) but answers with a real M2 unsigned envelope,
 * matching `shared/reasons.ts`'s documented design: "Any untyped exception is
 * mapped to `internal_error` by the error-handling middleware — a stack
 * trace never reaches the gateway."
 */
const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { body, status } = buildUnsigned("internal_error", {
    sessionId: null,
    meterReadingId: null,
    detail: err instanceof Error ? err.message : String(err),
  });
  res.status(status).json(body);
};

export function createServerApp(options: CreateServerAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // FC-R6: /health and /ready are never behind requireReady.
  app.get("/health", createHealthRoute());
  app.get("/ready", createReadyRoute(options.boot));

  const chargeRoute = createChargeRoute(
    {
      chargePort: createLiveChargePort(options.boot),
      network: options.network,
      explorerBaseUrl: options.explorerBaseUrl,
      pricePerMibRaw: options.pricePerMibRaw,
      ...(options.emit !== undefined ? { emit: options.emit } : {}),
    },
    options.cumulativeBytesStore,
  );

  app.get("/paid-resource", requireReady(options.boot), chargeRoute);

  // Last line of defense (review finding, Lote D): must be mounted after
  // every route so Express's error-handling dispatch (it recognizes an
  // error middleware by its 4-argument arity) picks it up for all of them.
  app.use(jsonErrorHandler);

  return app;
}

// Re-exported so `main.ts` and tests only need to import from `app.ts`.
export { createChargeService };
export type { ChargePort };
