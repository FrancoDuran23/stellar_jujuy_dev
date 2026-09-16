// Agent Express app (design 4.1; T3.3 scaffold, T5.3). Stage 1 does not need
// a long-running agent server for its own sake — the CLI (`agent/main.ts`)
// makes one paid request and exits — but `POST /vouchers` (WU5, "escalón
// 1.5") does, and its fail-closed wiring mirrors `server/app.ts` exactly:
// `requireReady` gates only the payment route, never `/health`, and the
// live instance is re-read from `boot` on every request instead of captured
// once, so a re-armed instance (FC-R8) is picked up without re-registering
// the route.
//
// Wiring this app into a running process (`agent/main.ts` calling
// `app.listen()` before `createAgentBoot()`'s first build, per FC-R1) is
// left for the batch that actually needs the agent to run as a server
// end-to-end — see docs/sdd/payments-mpp.md §6, Lote C, "open points".

import express, { type ErrorRequestHandler, type Express } from "express";
import type { FailClosedBoot } from "../config/boot.ts";
import { toM2Reason } from "../config/boot.ts";
import { buildUnsigned } from "../shared/messages.ts";
import { createVouchersRoute, type VoucherService } from "./routes/vouchers.ts";
import { requireReady } from "../server/middleware/require-ready.ts";

export type CreateAgentAppOptions = {
  boot: FailClosedBoot<VoucherService>;
  gatewayToken: string;
};

/**
 * Reads the current `VoucherService` from `boot` on every call instead of
 * capturing one at startup (same rationale as `server/app.ts`'s
 * `createLiveChargePort`): a re-armed instance (FC-R8) is picked up without
 * re-registering the route, and the fallback below — reusing
 * `buildUnsigned` so it can never disagree with the `REASONS` table — should
 * never actually trigger, since `requireReady` already blocks this route
 * while `boot` is not ready.
 */
function createLiveVoucherService(boot: Pick<FailClosedBoot<VoucherService>, "getState">): VoucherService {
  return {
    async handle(m1) {
      const state = boot.getState();
      if (state.status !== "ready") {
        return buildUnsigned(toM2Reason(state.reason), {
          sessionId: m1.sessionId,
          channel: m1.channel,
          meterReadingId: m1.meterReadingId,
          detail: state.detail,
        });
      }
      return state.instance.handle(m1);
    },
  };
}

const jsonParseErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(400).json({ error: "invalid JSON body" });
};

export function createAgentApp(options: CreateAgentAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // FC-R6: /health is never behind requireReady.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "alive" });
  });

  const liveService = createLiveVoucherService(options.boot);
  app.post(
    "/vouchers",
    requireReady(options.boot),
    createVouchersRoute({ gatewayToken: options.gatewayToken, service: liveService }),
  );

  // Turns an express.json() body-parse failure (malformed JSON) into a
  // clean JSON 400 instead of Express 5's default HTML error page.
  app.use(jsonParseErrorHandler);

  return app;
}
