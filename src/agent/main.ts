// Agent entrypoint (`npm run agent` / `npm run agent:serve`; T3.3, T8.2, and
// the review finding, Lote D, that closed WU5's "agent/main.ts not touched"
// open point). Two modes, dispatched on `process.argv[2]`:
//
// - default (no args): stage 1's headless CLI — one paid request against the
//   payment server, then exit, printing the settlement evidence a human
//   pastes into docs/payments-sdd.md §14.3 (S1-R4, S1-R7).
// - `serve`: stage 1.5's long-running process — `app.listen()` BEFORE
//   `createAgentBoot()`'s first `ensureReady()` (FC-R1, same order
//   `server/main.ts` uses), publishing `GET /health`, `GET /ready`, and
//   `POST /vouchers`.

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { parseAgentEnv } from "../config/env.ts";
import { createMppChargeClient, runOneShotPurchase } from "./charge-client.ts";
import { createAgentApp } from "./app.ts";
import { createAgentBoot, buildAgentVouchersInstance } from "../config/boot.ts";
import { createEventEmitter, createWebhookSink } from "../shared/events.ts";

const DEFAULT_RESOURCE_PATH = "/paid-resource";
// Matches `config/env.ts`'s `agentSchema.AGENT_PORT` default exactly (same
// pattern as `server/main.ts`'s `DEFAULT_PORT`): used only as a startup
// fallback when `parseAgentEnv` itself fails, so `app.listen()` still
// succeeds under FC-R1 even with a broken `.env`.
const DEFAULT_AGENT_PORT = 8081;

export type AgentMode = "serve" | "one-shot";

/** Pure mode dispatch (review finding, Lote D) — unit-testable without
 * touching `process.argv`, `app.listen()`, or any env/network side effect. */
export function resolveMode(argv: readonly string[]): AgentMode {
  return argv[2] === "serve" ? "serve" : "one-shot";
}

async function runOneShot(): Promise<void> {
  const parsed = parseAgentEnv(process.env);
  if (!parsed.ok) {
    console.error(
      JSON.stringify({ level: "error", msg: "invalid agent configuration", detail: parsed.detail }),
    );
    process.exitCode = 1;
    return;
  }

  const url = new URL(DEFAULT_RESOURCE_PATH, parsed.value.PAYMENT_SERVER_URL).toString();
  const port = createMppChargeClient(parsed.value.SIGNER_SECRET);

  try {
    const receipt = await runOneShotPurchase(port, url);
    console.log(
      JSON.stringify({
        level: "info",
        msg: "stage 1 purchase settled",
        txHash: receipt.txHash,
        explorerUrl: receipt.explorerUrl,
        network: receipt.network,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "stage 1 purchase failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

/**
 * Stage 1.5 long-running agent (FC-R1: `app.listen()` happens before the
 * boot's first `ensureReady()` attempt, so a bad `.env`/RPC never prevents
 * the port from accepting connections — the real failure is diagnosed by
 * `GET /ready`, same story as `server/main.ts`). A single best-effort parse
 * at startup only supplies the port/token fallbacks needed to listen; the
 * authoritative parse (and the resulting `config_invalid`/`voucher_log_
 * corrupt` diagnosis) happens inside `createAgentBoot`'s own `ensureReady()`.
 */
function runServe(): void {
  const parsedAtStartup = parseAgentEnv(process.env);
  const port = parsedAtStartup.ok ? parsedAtStartup.value.AGENT_PORT : DEFAULT_AGENT_PORT;
  const gatewayToken = parsedAtStartup.ok ? parsedAtStartup.value.GATEWAY_TOKEN : "";

  // EV-R4: webhook delivery is additive and optional — stdout emission
  // (EV-R1) never depends on it. Same wiring as `server/main.ts`.
  const webhookSink =
    parsedAtStartup.ok && parsedAtStartup.value.BACKEND_EVENTS_URL !== undefined
      ? createWebhookSink({ url: parsedAtStartup.value.BACKEND_EVENTS_URL })
      : undefined;
  const emitEvent = createEventEmitter(webhookSink);

  const boot = createAgentBoot({
    buildVouchersInstance: (env) => buildAgentVouchersInstance(env, { emit: emitEvent }),
  });
  const app = createAgentApp({ boot, gatewayToken });

  app.listen(port, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", msg: `payments-mpp agent listening on :${port}` })}\n`,
    );
    // FC-R1: the vouchers instance is built only after the port already
    // accepts connections.
    void boot.ensureReady();
  });
}

async function main(): Promise<void> {
  if (resolveMode(process.argv) === "serve") {
    runServe();
    return;
  }
  await runOneShot();
}

// Guards side effects behind an explicit "am I the entrypoint" check (rather
// than an unconditional `void main()`) so `resolveMode` can be imported and
// unit-tested without also starting a purchase or a server (review finding,
// Lote D).
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void main();
}
