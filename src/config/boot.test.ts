import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildAgentVouchersInstance,
  buildServerChannelInstance,
  createAgentBoot,
  createFailClosedBoot,
  createServerBoot,
  createServerChannelBoot,
  createServerDeliveringSigner,
  isChannelNotFoundOnChain,
  toM2Reason,
  type BuildResult,
  type UnavailableReason,
} from "./boot.ts";
import type { ChargePort } from "../server/charge-service.ts";
import { parseAgentEnv, parseServerEnv } from "./env.ts";
import type { SignerPort } from "../agent/signer.ts";
import { StellarMppError } from "@stellar/mpp";
import { UpstreamRpcError } from "../shared/retry.ts";

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

// --- server: stage-2 channel instance (WU7) ---

const CHANNEL = `C${"A".repeat(55)}`;
const FEE_PAYER_KEYPAIR = Keypair.random();

function makeChannelTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boot-channel-test-"));
}

function validServerChannelRawEnv(dataDir: string): Record<string, string> {
  return {
    ...validServerRawEnv,
    FEE_PAYER_SECRET: FEE_PAYER_KEYPAIR.secret(),
    CHANNEL_CONTRACT: CHANNEL,
    COMMITMENT_PUBKEY: "a".repeat(64),
    FUNDER_ACCOUNT: "G".padEnd(56, "B"),
    DATA_DIR: dataDir,
  };
}

test("createServerChannelBoot: unavailable/config_invalid when stage 2 is not configured", async () => {
  const boot = createServerChannelBoot({ rawEnv: validServerRawEnv });
  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.reason, "config_invalid");
  assert.match(state.detail, /stage 2/);
});

test("buildServerChannelInstance: a corrupt voucher log (not the last line) becomes unavailable/voucher_log_corrupt", async () => {
  const dir = makeChannelTempDir();
  const voucherLogPath = path.join(dir, "vouchers-server-testnet.jsonl");
  fs.writeFileSync(voucherLogPath, '{"not":"valid"}\nnot json at all\n{"v":1}\n');

  const parsed = parseServerEnv(validServerChannelRawEnv(dir));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.ok(parsed.value.CHANNEL_CONTRACT && parsed.value.COMMITMENT_PUBKEY && parsed.value.FUNDER_ACCOUNT);

  const result = await buildServerChannelInstance(
    parsed.value as typeof parsed.value & { CHANNEL_CONTRACT: string; COMMITMENT_PUBKEY: string; FUNDER_ACCOUNT: string },
    { voucherLogPath },
  );
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "voucher_log_corrupt");
});

test("buildServerChannelInstance: a healthy voucher log goes ready with a channelService and closeMonitor", async () => {
  const dir = makeChannelTempDir();
  const voucherLogPath = path.join(dir, "vouchers-server-testnet.jsonl");

  const parsed = parseServerEnv(validServerChannelRawEnv(dir));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await buildServerChannelInstance(
    parsed.value as typeof parsed.value & { CHANNEL_CONTRACT: string; COMMITMENT_PUBKEY: string; FUNDER_ACCOUNT: string },
    { voucherLogPath },
  );
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(typeof result.instance.channelService.verifyAndAccept, "function");
  assert.equal(typeof result.instance.closeMonitor.start, "function");
  // Never started automatically — server/main.ts decides when.
  assert.equal(result.instance.closeMonitor.getState().running, false);
});

test("buildServerChannelInstance: unavailable/channel_mismatch when the channel's own to/token do not match STELLAR_RECIPIENT/USDC_SAC_CONTRACT at boot (review finding 2, Lote F)", async () => {
  const dir = makeChannelTempDir();
  const voucherLogPath = path.join(dir, "vouchers-server-testnet.jsonl");

  const parsed = parseServerEnv(validServerChannelRawEnv(dir));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await buildServerChannelInstance(
    parsed.value as typeof parsed.value & { CHANNEL_CONTRACT: string; COMMITMENT_PUBKEY: string; FUNDER_ACCOUNT: string },
    {
      voucherLogPath,
      statePort: {
        async getChannelInfo() {
          return {
            found: true,
            depositRaw: 1000n,
            balanceRaw: 1000n,
            closeEffectiveAtLedger: null,
            currentLedger: 1,
            to: "G".padEnd(56, "Z"), // != STELLAR_RECIPIENT
            token: parsed.value.USDC_SAC_CONTRACT,
          };
        },
      },
    },
  );
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "channel_mismatch");
});

test("buildServerChannelInstance: a matching channel identity at boot goes ready (review finding 2, Lote F)", async () => {
  const dir = makeChannelTempDir();
  const voucherLogPath = path.join(dir, "vouchers-server-testnet.jsonl");

  const parsed = parseServerEnv(validServerChannelRawEnv(dir));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await buildServerChannelInstance(
    parsed.value as typeof parsed.value & { CHANNEL_CONTRACT: string; COMMITMENT_PUBKEY: string; FUNDER_ACCOUNT: string },
    {
      voucherLogPath,
      statePort: {
        async getChannelInfo() {
          return {
            found: true,
            depositRaw: 1000n,
            balanceRaw: 1000n,
            closeEffectiveAtLedger: null,
            currentLedger: 1,
            to: parsed.value.STELLAR_RECIPIENT,
            token: parsed.value.USDC_SAC_CONTRACT,
          };
        },
      },
    },
  );
  assert.equal(result.status, "ready");
});

test("createServerChannelBoot: a malformed FEE_PAYER_SECRET checksum becomes unavailable/config_invalid, never an uncaught rejection (FC-R2)", async () => {
  const dir = makeChannelTempDir();
  const boot = createServerChannelBoot({
    rawEnv: { ...validServerChannelRawEnv(dir), FEE_PAYER_SECRET: "S".padEnd(56, "A") },
  });
  const state = await boot.ensureReady();
  assert.equal(state.status, "unavailable");
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

test("buildAgentVouchersInstance: an explicit signer/depositPort override always wins, even in stage 2", async () => {
  const dir = makeTempDir();
  const voucherLogPath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const env = parseAgentEnv({
    ...validAgentRawEnv,
    CHANNEL_CONTRACT: "C".padEnd(56, "A"),
    COMMITMENT_SECRET: Keypair.random().secret(),
  });
  assert.equal(env.ok, true);
  if (!env.ok) return;

  let signCalls = 0;
  const result = await buildAgentVouchersInstance(env.value, {
    voucherLogPath,
    signer: {
      async sign() {
        signCalls += 1;
        return { signature: "a".repeat(128), commitmentPubkey: "b".repeat(64) };
      },
    },
    depositPort: {
      async getChannelInfo() {
        return { status: "open", depositRaw: 1_000_000n };
      },
    },
  });
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
  assert.equal(signCalls, 1);
});

test("buildAgentVouchersInstance: unavailable/commitment_key_mismatch when COMMITMENT_PUBKEY does not match COMMITMENT_SECRET's derived key (review finding 9, Lote F)", async () => {
  const dir = makeTempDir();
  const voucherLogPath = path.join(dir, "vouchers-agent-testnet.jsonl");

  const env = parseAgentEnv({
    ...validAgentRawEnv,
    CHANNEL_CONTRACT: "C".padEnd(56, "A"),
    COMMITMENT_SECRET: Keypair.random().secret(),
    COMMITMENT_PUBKEY: "a".repeat(64), // deliberately wrong
  });
  assert.equal(env.ok, true);
  if (!env.ok) return;

  const result = await buildAgentVouchersInstance(env.value, { voucherLogPath });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "commitment_key_mismatch");
});

test("buildAgentVouchersInstance: a matching COMMITMENT_PUBKEY goes ready (review finding 9, Lote F)", async () => {
  const dir = makeTempDir();
  const voucherLogPath = path.join(dir, "vouchers-agent-testnet.jsonl");
  const commitmentKeypair = Keypair.random();

  const env = parseAgentEnv({
    ...validAgentRawEnv,
    CHANNEL_CONTRACT: "C".padEnd(56, "A"),
    COMMITMENT_SECRET: commitmentKeypair.secret(),
    COMMITMENT_PUBKEY: Buffer.from(commitmentKeypair.rawPublicKey()).toString("hex"),
  });
  assert.equal(env.ok, true);
  if (!env.ok) return;

  const result = await buildAgentVouchersInstance(env.value, { voucherLogPath });
  assert.equal(result.status, "ready");
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

// --- createServerDeliveringSigner (WU7): agent -> server delivery wrapper ---

function fakeInnerSigner(): SignerPort {
  return {
    async sign() {
      return { signature: "a".repeat(128), commitmentPubkey: "b".repeat(64) };
    },
  };
}

test("createServerDeliveringSigner: POSTs to /channel/vouchers and returns the inner signer's result when accepted", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ accepted: true, remaining: "999000" }), { status: 200 });
  }) as typeof fetch;

  const signer = createServerDeliveringSigner(fakeInnerSigner(), {
    paymentServerUrl: "http://127.0.0.1:8080",
    fetchImpl,
  });
  const result = await signer.sign({
    channel: `C${"A".repeat(55)}`,
    network: "stellar:testnet",
    cumulativeAmount: "1000",
    sessionId: "sess_1",
    cumulativeBytes: 1_048_576,
    meterReadingId: "mr_1",
  });
  assert.equal(result.signature, "a".repeat(128));
  assert.equal(capturedUrl, "http://127.0.0.1:8080/channel/vouchers");
  assert.equal((capturedBody as { cumulativeAmount: string }).cumulativeAmount, "1000");
  assert.equal((capturedBody as { signature: string }).signature, "a".repeat(128));
});

test("createServerDeliveringSigner: a reused:true acceptance (crash-then-retry replay) is treated as success, never thrown (review finding 4, Lote F)", async () => {
  const signer = createServerDeliveringSigner(fakeInnerSigner(), {
    paymentServerUrl: "http://127.0.0.1:8080",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ accepted: true, remaining: "999000", reused: true }), { status: 200 })) as typeof fetch,
  });
  const result = await signer.sign({
    channel: `C${"A".repeat(55)}`,
    network: "stellar:testnet",
    cumulativeAmount: "1000",
    sessionId: "sess_1",
    cumulativeBytes: 1_048_576,
    meterReadingId: "mr_1",
  });
  assert.equal(result.signature, "a".repeat(128));
});

test("createServerDeliveringSigner: throws when the server rejects the voucher (accepted:false)", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ accepted: false, reason: "channel_closing", detail: "close_start seen" }), {
      status: 200,
    })) as typeof fetch;
  const signer = createServerDeliveringSigner(fakeInnerSigner(), {
    paymentServerUrl: "http://127.0.0.1:8080",
    fetchImpl,
  });
  await assert.rejects(
    () =>
      signer.sign({
        channel: `C${"A".repeat(55)}`,
        network: "stellar:testnet",
        cumulativeAmount: "1000",
        sessionId: "sess_1",
        cumulativeBytes: 1,
        meterReadingId: "mr_1",
      }),
    /channel_closing/,
  );
});

test("createServerDeliveringSigner: throws on a non-2xx HTTP response", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch;
  const signer = createServerDeliveringSigner(fakeInnerSigner(), {
    paymentServerUrl: "http://127.0.0.1:8080",
    fetchImpl,
  });
  await assert.rejects(() =>
    signer.sign({
      channel: `C${"A".repeat(55)}`,
      network: "stellar:testnet",
      cumulativeAmount: "1000",
      sessionId: "sess_1",
      cumulativeBytes: 1,
      meterReadingId: "mr_1",
    }),
  );
});

// --- isChannelNotFoundOnChain (review finding 5, Lote F) ---

test("isChannelNotFoundOnChain: true only for StellarMppError (getChannelState's own definitive simulation failure)", () => {
  assert.equal(isChannelNotFoundOnChain(new StellarMppError("Failed to simulate balance on channel CABC...: HostError")), true);
});

test("isChannelNotFoundOnChain: false for a plain transport-style error (DNS/connection/timeout) — never mistaken for not-found", () => {
  assert.equal(isChannelNotFoundOnChain(new Error("fetch failed")), false);
  assert.equal(isChannelNotFoundOnChain(new TypeError("ECONNREFUSED")), false);
  assert.equal(isChannelNotFoundOnChain(new UpstreamRpcError("channel state RPC call failed: fetch failed")), false);
  assert.equal(isChannelNotFoundOnChain("not even an Error instance"), false);
});
