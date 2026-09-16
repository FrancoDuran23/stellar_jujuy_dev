// Day-1 trustline preflight (design 4.9 R1 mitigation; spec CL-R12; T3.4).
// WARN-only, by design: a missing USDC trustline is "the #1 error"
// (proposal 2.5) but CL-R12 and R1's mitigation are both explicit that this
// must never block startup — this script only surfaces the problem early.
//
// The pure `runPreflight()` function below takes a `TrustlinePort` (defined
// in `shared/stellar/trustline.ts`) and never imports the Stellar SDK
// directly, so it is fully testable with a fake. Only the CLI entrypoint at
// the bottom of this file wires up the real, Horizon-backed port.

// Loads `.env` the same way `src/server/main.ts` and `src/agent/main.ts` do.
// Without this, `parseServerEnv(process.env)` below only ever sees whatever
// is already exported in the shell — the runbook's `npm run preflight`
// (docs/sdd/payments-mpp.md §6, T8.2 step 4) expects it to read the same
// `.env` file the server and agent use.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { describeMissingTrustline, type TrustlinePort } from "../src/shared/stellar/trustline.ts";

export type PreflightAccountRole = "recipient" | "funder";

export type PreflightAccount = { role: PreflightAccountRole; accountId: string };

export type PreflightWarning = { role: PreflightAccountRole; accountId: string; detail: string };

export type PreflightResult = { warnings: PreflightWarning[] };

/**
 * Checks the USDC trustline on every given account. Always resolves — never
 * rejects and never signals "blocked" — a missing trustline on one account
 * (of possibly several checked) is reported as a warning, not a failure
 * (CL-R12: "SHALL emitir WARN si falta en alguna, sin bloquear el arranque").
 */
export async function runPreflight(
  trustlinePort: TrustlinePort,
  accounts: readonly PreflightAccount[],
): Promise<PreflightResult> {
  const warnings: PreflightWarning[] = [];
  for (const account of accounts) {
    const hasTrustline = await trustlinePort.hasUsdcTrustline(account.accountId);
    if (!hasTrustline) {
      warnings.push({
        role: account.role,
        accountId: account.accountId,
        detail: describeMissingTrustline(account.accountId),
      });
    }
  }
  return { warnings };
}

export function printPreflightResult(result: PreflightResult, log: typeof console = console): void {
  for (const warning of result.warnings) {
    log.warn(
      JSON.stringify({
        level: "warn",
        reason: "usdc_trustline_missing",
        role: warning.role,
        accountId: warning.accountId,
        detail: warning.detail,
      }),
    );
  }
  if (result.warnings.length === 0) {
    log.log(
      JSON.stringify({ level: "info", msg: "preflight: USDC trustline present on all checked accounts" }),
    );
  }
}

// CLI entrypoint (`npm run preflight`) — never runs when this module is
// imported by tests. Wires the real, Horizon-backed TrustlinePort: USDC here
// is a SEP-41 SAC wrapping a classic asset, and the classic trustline that
// gates it lives in Horizon account balances, not in Soroban RPC account
// state — so this is the one place this script talks to Horizon instead of
// Soroban RPC.
//
// Guarded the same way `src/agent/main.ts` guards its own entrypoint check:
// `import.meta.url === \`file://${process.argv[1]}\`` never matches on
// Windows, where `import.meta.url` is `file:///D:/...` (three slashes plus a
// drive letter) while the naive template literal only ever produces
// `file:///argv1` with no drive-letter normalization — so `npm run preflight`
// silently ran nothing on Windows. `pathToFileURL` normalizes the drive
// letter and slash count on every platform.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [{ Horizon }, { parseServerEnv }, { HORIZON_URLS }] = await Promise.all([
    import("@stellar/stellar-sdk"),
    import("../src/config/env.ts"),
    import("@stellar/mpp"),
  ]);

  const parsed = parseServerEnv(process.env);
  if (!parsed.ok) {
    console.error(
      JSON.stringify({ level: "error", msg: "preflight: invalid configuration", detail: parsed.detail }),
    );
    process.exitCode = 1;
  } else {
    const horizon = new Horizon.Server(HORIZON_URLS[parsed.value.STELLAR_NETWORK]);
    const trustlinePort: TrustlinePort = {
      async hasUsdcTrustline(accountId) {
        try {
          const account = await horizon.loadAccount(accountId);
          return account.balances.some(
            (balance) => "asset_code" in balance && balance.asset_code === "USDC",
          );
        } catch {
          return false;
        }
      },
    };

    const accounts: PreflightAccount[] = [{ role: "recipient", accountId: parsed.value.STELLAR_RECIPIENT }];
    if (parsed.value.FUNDER_ACCOUNT !== undefined) {
      accounts.push({ role: "funder", accountId: parsed.value.FUNDER_ACCOUNT });
    }

    printPreflightResult(await runPreflight(trustlinePort, accounts));
  }
}
