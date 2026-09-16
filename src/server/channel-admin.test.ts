// Review finding 10b, Lote F: `channel-admin.ts` is an operator CLI whose
// `close` subcommand moves real funds — it must refuse to run at all against
// `stellar:pubnet` rather than trust a copy-pasted `.env`. `main()` is not
// exported (it is the module's own entrypoint, same shape as `agent/
// main.ts`), so this spawns the real script exactly as `npm run
// channel-admin:state` does — the pubnet guard runs right after env parsing
// and before any Soroban RPC call, so this never touches the network.
//
// Spawned with `cwd` set to a fresh temp directory (no `.env` there) so
// `dotenv/config`'s implicit `.env` load can never pull the repo's own
// real secrets into the child process.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "src", "server", "channel-admin.ts");

function minimalServerEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STELLAR_NETWORK: "stellar:testnet",
    STELLAR_RECIPIENT: Keypair.random().publicKey(),
    MPP_SECRET_KEY: "a-generic-non-empty-secret",
    FEE_PAYER_SECRET: Keypair.random().secret(),
    PRICE_PER_MIB_RAW: "10000",
    ...overrides,
  };
}

function runAdmin(command: string, envOverrides: Record<string, string> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "channel-admin-test-"));
  const env = { ...minimalServerEnv(envOverrides), PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
  return spawnSync(process.execPath, [SCRIPT, command], { cwd, env, encoding: "utf8", timeout: 10_000 });
}

test("channel-admin refuses to run any command against stellar:pubnet (review finding 10b, Lote F)", () => {
  for (const command of ["state", "close"]) {
    const result = runAdmin(command, { STELLAR_NETWORK: "stellar:pubnet" });
    assert.equal(result.status, 1, `${command}: expected exit code 1, stderr: ${result.stderr}`);
    assert.match(result.stderr, /stellar:pubnet/);
  }
});

test("channel-admin proceeds past the network guard on stellar:testnet (fails later only for lack of stage-2 config, never for the network)", () => {
  const result = runAdmin("state", { STELLAR_NETWORK: "stellar:testnet" });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /refusing to run against/);
  assert.match(result.stderr, /stage 2 is not configured/);
});
