import { test } from "node:test";
import assert from "node:assert/strict";
import { printPreflightResult, runPreflight, type PreflightAccount } from "./preflight.ts";
import type { TrustlinePort } from "../src/shared/stellar/trustline.ts";

const RECIPIENT = "G".padEnd(56, "A");
const FUNDER = "G".padEnd(56, "B");

function fakeTrustlinePort(missing: readonly string[]): TrustlinePort {
  return {
    async hasUsdcTrustline(accountId) {
      return missing.includes(accountId) ? "no" : "yes";
    },
  };
}

test("runPreflight warns and does not block when one of two accounts is missing the trustline (CL-R12)", async () => {
  const accounts: PreflightAccount[] = [
    { role: "recipient", accountId: RECIPIENT },
    { role: "funder", accountId: FUNDER },
  ];
  const result = await runPreflight(fakeTrustlinePort([FUNDER]), accounts);

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.role, "funder");
  assert.equal(result.warnings[0]!.accountId, FUNDER);
  assert.match(result.warnings[0]!.detail, /does not hold/);
});

test("runPreflight returns no warnings when both accounts have the trustline", async () => {
  const accounts: PreflightAccount[] = [
    { role: "recipient", accountId: RECIPIENT },
    { role: "funder", accountId: FUNDER },
  ];
  const result = await runPreflight(fakeTrustlinePort([]), accounts);
  assert.deepEqual(result.warnings, []);
});

test("runPreflight warns for every account missing the trustline, never throws", async () => {
  const accounts: PreflightAccount[] = [
    { role: "recipient", accountId: RECIPIENT },
    { role: "funder", accountId: FUNDER },
  ];
  const result = await runPreflight(fakeTrustlinePort([RECIPIENT, FUNDER]), accounts);
  assert.equal(result.warnings.length, 2);
});

test("runPreflight warns (does not throw or block) when the trustline lookup itself fails (status: unknown)", async () => {
  const accounts: PreflightAccount[] = [{ role: "recipient", accountId: RECIPIENT }];
  const trustlinePort: TrustlinePort = { async hasUsdcTrustline() { return "unknown"; } };
  const result = await runPreflight(trustlinePort, accounts);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!.detail, /could not verify/);
});

test("printPreflightResult logs one warn line per warning and an info line when there are none", () => {
  const warnLines: string[] = [];
  const logLines: string[] = [];
  const fakeConsole = {
    warn: (line: string) => warnLines.push(line),
    log: (line: string) => logLines.push(line),
  } as unknown as typeof console;

  printPreflightResult(
    { warnings: [{ role: "funder", accountId: FUNDER, detail: "missing" }] },
    fakeConsole,
  );
  assert.equal(warnLines.length, 1);
  assert.equal(logLines.length, 0);
  assert.equal(JSON.parse(warnLines[0]!).reason, "usdc_trustline_missing");

  printPreflightResult({ warnings: [] }, fakeConsole);
  assert.equal(logLines.length, 1);
});
