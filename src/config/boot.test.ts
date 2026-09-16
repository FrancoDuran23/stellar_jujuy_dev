import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAgentVouchersInstance,
  createAgentBoot,
  createFailClosedBoot,
  createServerBoot,
  toM2Reason,
  type BuildResult,
  type UnavailableReason,
} from "./boot.ts";
import type { ChargePort } from "../server/charge-service.ts";
import { parseAgentEnv } from "./env.ts";

const fakeChargePort: ChargePort = {
  async handle() {
    throw new Error("not used in these tests");
  },
};

function ready(): BuildResult<ChargePort> {
  return { status: "ready", instance: fakeChargePort };
}

function unavailable(reason: UnavailableReason): BuildResult<ChargePort> {
  return { status: "unavailable", reason, detail: "unavailable" };
}

test("createFailClosedBoot: the first ensureReady() always attempts", async () => {
  let calls = 0;
  const boot = createFailClosedBoot<ChargePort>({
    retryIntervalMs: 10_000,
    buildInstance: async () => {
      calls += 1;
      return ready();
    },
  });

  assert.equal(boot.getState().status, "unavailable");
  const state = await boot.ensureReady();
  assert.equal(state.status, "ready");
  assert.equal(calls, 1);
});

test("createFailClosedBoot: throttles re-attempts to at most once per retryIntervalMs (FC-R8)", async () => {
  let calls = 0;
  let now = 0;
  const boot = createFailClosedBoot<ChargePort>({
    retryIntervalMs: 10_000,
    now: () => now,
    buildInstance: async () => {
      calls += 1;
      return unavailable("upstream_unavailable");
    },
  });

  await boot.ensureReady();
  assert.equal(calls, 1);

  // Still within the throttle window — no new attempt.
  now += 5_000;
  await boot.ensureReady();
  assert.equal(calls, 1);

  // Past the throttle window — attempts again (recovery without restart).
  now += 5_001;
  await boot.ensureReady();
  assert.equal(calls, 2);
});

test("createFailClosedBoot: recovers to ready once the RPC comes back, without a restart", async () => {
  let now = 0;
  let healthy = false;
  const boot = createFailClosedBoot<ChargePort>({
    retryIntervalMs: 10_000,
    now: () => now,
    buildInstance: async () =>
      healthy ? ready() : unavailable("upstream_unavailable"),
  });

  const first = await boot.ensureReady();
  assert.equal(first.status, "unavailable");

  healthy = true;
  now += 10_001;
  const second = await boot.ensureReady();
  assert.equal(second.status, "ready");
});

test("createFailClosedBoot: concurrent ensureReady() calls share one in-flight attempt", async () => {
  let calls = 0;
  let resolveBuild!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveBuild = resolve;
  });
  const boot = createFailClosedBoot<ChargePort>({
    retryIntervalMs: 10_000,
    buildInstance: async () => {
      calls += 1;
      await gate;
      return ready();
    },
  });

  const a = boot.ensureReady();
  const b = boot.ensureReady();
  resolveBuild();
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(calls, 1, "two concurrent callers must not trigger two build attempts");
  assert.equal(resultA.status, "ready");
  assert.equal(resultB.status, "ready");
});

test("createFailClosedBoot: a throwing buildInstance becomes unavailable/internal_error, never an uncaught rejection (FC-R2)", async () => {
  const boot = createFailClosedBoot<ChargePort>({
    retryIntervalMs: 10_000,
    buildInstance: async () => {
      throw new Error("boom");
    },
  });

  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.reason, "internal_error");
  assert.match(state.detail, /boom/);
});

test("createFailClosedBoot: once ready, later ensureReady() calls never re-attempt", async () => {
  let calls = 0;
  const boot = createFailClosedBoot<ChargePort>({
    retryIntervalMs: 10_000,
    buildInstance: async () => {
      calls += 1;
      return ready();
    },
  });

  await boot.ensureReady();
  await boot.ensureReady();
  await boot.ensureReady();
  assert.equal(calls, 1);
});

test("toM2Reason passes a real M2 Reason through unchanged", () => {
  assert.equal(toM2Reason("upstream_unavailable"), "upstream_unavailable");
  assert.equal(toM2Reason("channel_exhausted"), "channel_exhausted");
});

test("toM2Reason maps alarm-only reasons to internal_error — never leaked into M2 (design 4.5)", () => {
  assert.equal(toM2Reason("config_invalid"), "internal_error");
  assert.equal(toM2Reason("voucher_log_corrupt"), "internal_error");
});

const validServerRawEnv: Record<string, string> = {
  STELLAR_RECIPIENT: "G".padEnd(56, "A"),
  MPP_SECRET_KEY: "a-generic-non-empty-secret",
  FEE_PAYER_SECRET: "S".padEnd(56, "A"),
  PRICE_PER_MIB_RAW: "10000",
};

test("createServerBoot: a malformed COMMITMENT_PUBKEY becomes unavailable/config_invalid and names the variable without leaking secrets (CF-R3)", async () => {
  const boot = createServerBoot({
    rawEnv: { ...validServerRawEnv, COMMITMENT_PUBKEY: "not-hex" },
    buildChargeInstance: async () => ready(),
  });

  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.reason, "config_invalid");
  assert.match(state.detail, /COMMITMENT_PUBKEY/);
  assert.equal(state.detail.includes(validServerRawEnv.FEE_PAYER_SECRET!), false);
});

test("createServerBoot: valid env delegates to buildChargeInstance and can go ready", async () => {
  const boot = createServerBoot({
    rawEnv: validServerRawEnv,
    buildChargeInstance: async () => ready(),
  });

  const state = await boot.ensureReady();
  assert.equal(state.status, "ready");
});

test("createServerBoot: RPC-down (from buildChargeInstance) surfaces as upstream_unavailable, mappable to a diagnosable /ready state within the same call (10s diagnosis scenario)", async () => {
  const boot = createServerBoot({
    rawEnv: validServerRawEnv,
    buildChargeInstance: async () => unavailable("upstream_unavailable"),
  });

  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.reason, "upstream_unavailable");
  assert.equal(toM2Reason(state.reason), "upstream_unavailable");
});

// --- agent: FC-R3, batch B deviation 6 ("voucher log no abrible en modo
// append" was the one FC-R3 condition not yet wired — WU5 closes it) ---

const validAgentRawEnv: Record<string, string> = {
  GATEWAY_TOKEN: "test-gateway-token",
  SIGNER_SECRET: "S".padEnd(56, "A"),
  PRICE_PER_MIB_RAW: "10000",
};

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boot-agent-test-"));
}

test("buildAgentVouchersInstance: a corrupt voucher log (not the last line) becomes unavailable/voucher_log_corrupt (FC-R3)", async () => {
  const dir = makeTempDir();
  const voucherLogPath = path.join(dir, "vouchers-agent-testnet.jsonl");
  fs.writeFileSync(voucherLogPath, '{"not":"valid"}\nnot json at all\n{"v":1}\n');

  const env = parseAgentEnv(validAgentRawEnv);
  assert.equal(env.ok, true);
  if (!env.ok) return;

  const result = await buildAgentVouchersInstance(env.value, { voucherLogPath });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "voucher_log_corrupt");
  assert.match(result.detail, /line 1/);
});

test("buildAgentVouchersInstance: a healthy/missing voucher log goes ready and its VoucherService can sign", async () => {
  const dir = makeTempDir();
  const voucherLogPath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const env = parseAgentEnv(validAgentRawEnv);
  assert.equal(env.ok, true);
  if (!env.ok) return;

  const result = await buildAgentVouchersInstance(env.value, { voucherLogPath });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;

  const outcome = await result.instance.handle({
    version: 1,
    sessionId: "sess_1",
    channel: `C${"A".repeat(55)}`,
    network: "stellar:testnet",
    asset: "USDC",
    cumulativeBytes: 1_048_576,
    cumulativeAmount: "10000",
    meterReadingId: "mr_1",
    observedAt: "2026-09-20T18:04:02.118Z",
  });
  assert.equal(outcome.body.status, "signed");
});

test("createAgentBoot: a corrupt voucher log makes the whole boot unavailable, mapping to internal_error for M2 (FC-R5)", async () => {
  const boot = createAgentBoot({
    rawEnv: validAgentRawEnv,
    buildVouchersInstance: async () => ({
      status: "unavailable",
      reason: "voucher_log_corrupt",
      detail: "line 2 of the log is corrupt and is not the last line",
    }),
  });

  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.reason, "voucher_log_corrupt");
  assert.equal(toM2Reason(state.reason), "internal_error");
});

test("createAgentBoot: a malformed GATEWAY_TOKEN-less env becomes unavailable/config_invalid, never the voucher_log_corrupt path", async () => {
  const { GATEWAY_TOKEN: _omit, ...withoutGatewayToken } = validAgentRawEnv;
  const boot = createAgentBoot({
    rawEnv: withoutGatewayToken,
    buildVouchersInstance: async () => {
      throw new Error("must not be called: env parsing should fail first");
    },
  });

  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.reason, "config_invalid");
  assert.match(state.detail, /GATEWAY_TOKEN/);
});
