// Express app assembly for the payment server (design 4.1, 4.5; T3.2, T4.1).
// This is the only file that wires routes/middleware together; the SDK
// itself is never touched here — only through `FailClosedBoot<ChargePort>`,
// built in `config/boot.ts`.

import express, { type Express } from "express";
import type { FailClosedBoot } from "../config/boot.ts";
import type { EmitInput } from "../shared/events.ts";
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

  return app;
}

// Re-exported so `main.ts` and tests only need to import from `app.ts`.
export { createChargeService };
export type { ChargePort };
