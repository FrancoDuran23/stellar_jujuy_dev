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
import { parseNonNegativeIntegerRaw } from "../shared/money.ts";

const DEFAULT_RESOURCE_PATH = "/paid-resource";
// Matches `config/env.ts`'s `agentSchema.AGENT_PORT` default exactly (same
// pattern as `server/main.ts`'s `DEFAULT_PORT`): used only as a startup
// fallback when `parseAgentEnv` itself fails, so `app.listen()` still
// succeeds under FC-R1 even with a broken `.env`.
const DEFAULT_AGENT_PORT = 8081;
// Matches `server/routes/charge.ts`'s own `DEFAULT_CUMULATIVE_BYTES` (flat
// 1 MiB) — the one-shot CLI's default when neither `--bytes` nor
// `CUMULATIVE_BYTES` is given must agree with the server's bare-call default.
const DEFAULT_CUMULATIVE_BYTES = 1_048_576n;

export type AgentMode = "serve" | "one-shot";

/** Pure mode dispatch (review finding, Lote D) — unit-testable without
 * touching `process.argv`, `app.listen()`, or any env/network side effect. */
export function resolveMode(argv: readonly string[]): AgentMode {
  return argv[2] === "serve" ? "serve" : "one-shot";
}

export type CumulativeBytesResult =
  | { ok: true; value: bigint }
  | { ok: false; detail: string };

/**
 * Resolves `?cumulativeBytes=` for the one-shot CLI (T8.2 open finding #2:
 * there was previously no way to pass it at all, forcing a throwaway script
 * for a testnet run above the flat 1 MiB default — see docs/sdd/
 * payments-mpp.md §6). Precedence: `--bytes <n>` flag, then the
 * `CUMULATIVE_BYTES` env var, then the default. Uses the same non-negative
 * integer parser as the server's own `?cumulativeBytes=` (`shared/money.ts`)
 * so the CLI and the route can never disagree on what a valid value looks
 * like. Never throws — a malformed value is a typed failure (same shape as
 * `parseAgentEnv`), not an uncaught exception.
 */
export function resolveCumulativeBytes(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CumulativeBytesResult {
  const flagIndex = argv.indexOf("--bytes");
  if (flagIndex !== -1) {
    const raw = argv[flagIndex + 1];
    if (raw === undefined) {
      return { ok: false, detail: "--bytes requires a value" };
    }
    const parsed = parseNonNegativeIntegerRaw(raw);
    if (parsed === undefined) {
      return { ok: false, detail: `--bytes must be a non-negative integer, got "${raw}"` };
    }
    return { ok: true, value: parsed };
  }

  // dotenv parses a bare `CUMULATIVE_BYTES=` line as `""`, not `undefined`
  // (same pitfall documented in `config/env.ts`'s `emptyToUndefined`) — treat
  // it as unset rather than a parse failure.
  const envValue = env.CUMULATIVE_BYTES;
  if (envValue !== undefined && envValue !== "") {
    const parsed = parseNonNegativeIntegerRaw(envValue);
    if (parsed === undefined) {
      return {
        ok: false,
        detail: `CUMULATIVE_BYTES must be a non-negative integer, got "${envValue}"`,
      };
    }
    return { ok: true, value: parsed };
  }

  return { ok: true, value: DEFAULT_CUMULATIVE_BYTES };
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

  const cumulativeBytes = resolveCumulativeBytes(process.argv, process.env);
  if (!cumulativeBytes.ok) {
    console.error(
      JSON.stringify({ level: "error", msg: "invalid cumulative bytes value", detail: cumulativeBytes.detail }),
    );
    process.exitCode = 1;
    return;
  }

  const url = new URL(DEFAULT_RESOURCE_PATH, parsed.value.PAYMENT_SERVER_URL);
  url.searchParams.set("cumulativeBytes", cumulativeBytes.value.toString());
  const port = createMppChargeClient(parsed.value.SIGNER_SECRET);

  try {
    const outcome = await runOneShotPurchase(port, url.toString());

    if (outcome.kind === "settled") {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "stage 1 purchase settled",
          txHash: outcome.receipt.txHash,
          explorerUrl: outcome.receipt.explorerUrl,
          network: outcome.receipt.network,
        }),
      );
      return;
    }

    // M2 unsigned envelope (T8.2 open finding #1) — always a clean, typed
    // business outcome, never a crash. `retryable` (never HTTP status alone,
    // FT-R6) decides the exit code: non-retryable is exit 0 (nothing to
    // retry, e.g. `stale_reading`), retryable is exit 1 so scripts notice.
    if (outcome.retryable) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "stage 1 purchase temporarily unavailable, retry later",
          reason: outcome.reason,
          detail: outcome.detail,
          ...(outcome.retryAfterSeconds !== null
            ? { retryAfterSeconds: outcome.retryAfterSeconds }
            : {}),
        }),
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify({
        level: "info",
        msg: "nothing new to bill; pass a higher cumulative bytes value (--bytes <n> or CUMULATIVE_BYTES)",
        reason: outcome.reason,
        detail: outcome.detail,
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
