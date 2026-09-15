// Agent Express app (design 4.1; T3.3 scaffold). Stage 1 does not need a
// long-running agent server at all — the CLI (`agent/main.ts`) makes one
// paid request and exits — but this scaffold exists now so WU5's
// `POST /vouchers` (T5.3) and its fail-closed wiring (mirroring
// `server/app.ts`) have a shared starting point instead of a second,
// slightly-different app assembled from scratch. Only `/health` is mounted
// for now; there is no payment-route readiness gate here yet because there
// is no payment instance for the agent role in stage 1 (S1-R2, S1-R3: the
// agent only signs, it never builds or verifies anything server-side).

import express, { type Express } from "express";

export function createAgentApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "alive" });
  });
  return app;
}
