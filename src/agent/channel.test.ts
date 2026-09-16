// T6.1: argv parsing + orchestration tested purely with a fake ChannelPort
// and a fake ChannelRecordStore — never touches the network or the
// filesystem.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  runChannelCli,
  type ChannelOpenResult,
  type ChannelPort,
  type ChannelRecordStore,
  type ChannelStateSummary,
  type ChannelTxResult,
  type CliEnv,
  type CliIO,
} from "./channel.ts";
import type { ChannelRecord } from "../persistence/channel-record.ts";
import { Keypair } from "@stellar/stellar-sdk";

const CHANNEL = `C${"A".repeat(55)}`;
const FUNDER_KEYPAIR = Keypair.random();
const FUNDER_SECRET = FUNDER_KEYPAIR.secret();
const RECIPIENT = Keypair.random().publicKey();
const COMMITMENT_SECRET = Keypair.random().secret();

function baseEnv(overrides: Partial<CliEnv> = {}): CliEnv {
  return {
    funderSecret: FUNDER_SECRET,
    recipientPublicKey: RECIPIENT,
    usdcContract: `C${"C".repeat(55)}`,
    network: "stellar:testnet",
    commitmentSecret: COMMITMENT_SECRET,
    channelContract: CHANNEL,
    ...overrides,
  };
}

function fakeIO(): CliIO & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  };
}

function fakeRecordStore(): ChannelRecordStore & { records: ChannelRecord[] } {
  const records: ChannelRecord[] = [];
  return {
    records,
    read: () => records[records.length - 1],
    write: (record) => {
      records.push(record);
    },
  };
}

function fakePort(overrides: Partial<ChannelPort> = {}): ChannelPort & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { open: [], topUp: [], closeStart: [], refund: [], state: [] };
  const openResult: ChannelOpenResult = { channel: CHANNEL, txHash: "open-hash", deployLedger: 100, feeChargedStroops: "5000" };
  const txResult: ChannelTxResult = { txHash: "tx-hash", feeChargedStroops: "1000" };
  const stateResult: ChannelStateSummary = {
    token: `C${"D".repeat(55)}`,
    from: "GFROM",
    to: "GTO",
    refundWaitingPeriodLedgers: 60,
    balanceRaw: 1_000n,
    depositedRaw: 1_000n,
    closeEffectiveAtLedger: null,
    currentLedger: 500,
    pendingDispute: false,
  };
  return {
    calls,
    async open(params) {
      calls.open.push(params);
      return overrides.open ? overrides.open(params) : openResult;
    },
    async topUp(params) {
      calls.topUp.push(params);
      return overrides.topUp ? overrides.topUp(params) : txResult;
    },
    async closeStart(params) {
      calls.closeStart.push(params);
      return overrides.closeStart ? overrides.closeStart(params) : txResult;
    },
    async refund(params) {
      calls.refund.push(params);
      return overrides.refund ? overrides.refund(params) : txResult;
    },
    async state(params) {
      calls.state.push(params);
      return overrides.state ? overrides.state(params) : stateResult;
    },
  };
}

test("parseArgs: open requires --deposit", () => {
  const result = parseArgs(["node", "channel.ts", "open"]);
  assert.equal(result.command, "error");
});

test("parseArgs: open parses --deposit and defaults --waiting-period to 60", () => {
  const result = parseArgs(["node", "channel.ts", "open", "--deposit", "50000000"]);
  assert.deepEqual(result, { command: "open", depositRaw: 50_000_000n, waitingPeriodLedgers: 60 });
});

test("parseArgs: open honors an explicit --waiting-period", () => {
  const result = parseArgs(["node", "channel.ts", "open", "--deposit", "1", "--waiting-period", "120"]);
  assert.deepEqual(result, { command: "open", depositRaw: 1n, waitingPeriodLedgers: 120 });
});

test("parseArgs: top-up requires a positive --amount", () => {
  assert.equal(parseArgs(["node", "channel.ts", "top-up"]).command, "error");
  assert.equal(parseArgs(["node", "channel.ts", "top-up", "--amount", "0"]).command, "error");
  assert.deepEqual(parseArgs(["node", "channel.ts", "top-up", "--amount", "1000"]), {
    command: "top-up",
    amountRaw: 1000n,
  });
});

test("parseArgs: close-start, refund, state need no flags", () => {
  assert.deepEqual(parseArgs(["node", "channel.ts", "close-start"]), { command: "close-start" });
  assert.deepEqual(parseArgs(["node", "channel.ts", "refund"]), { command: "refund" });
  assert.deepEqual(parseArgs(["node", "channel.ts", "state"]), { command: "state" });
});

test("parseArgs: unknown subcommand is an error", () => {
  assert.equal(parseArgs(["node", "channel.ts", "bogus"]).command, "error");
  assert.equal(parseArgs(["node", "channel.ts"]).command, "error");
});

test("runChannelCli open: calls port.open with the parsed args, writes the record, never prints the secret", async () => {
  const port = fakePort();
  const store = fakeRecordStore();
  const io = fakeIO();
  const exitCode = await runChannelCli(
    ["node", "channel.ts", "open", "--deposit", "50000000", "--waiting-period", "60"],
    baseEnv({ channelContract: undefined }),
    port,
    store,
    io,
  );
  assert.equal(exitCode, 0);
  assert.equal(port.calls.open.length, 1);
  const openCall = port.calls.open[0] as { depositRaw: bigint; waitingPeriodLedgers: number; commitmentPubkeyHex: string };
  assert.equal(openCall.depositRaw, 50_000_000n);
  assert.equal(openCall.waitingPeriodLedgers, 60);
  assert.match(openCall.commitmentPubkeyHex, /^[0-9a-f]{64}$/);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0]!.channel, CHANNEL);
  assert.equal(store.records[0]!.depositRaw, "50000000");
  const allOutput = [...io.logs, ...io.errors].join("\n");
  assert.equal(allOutput.includes(FUNDER_SECRET), false);
  assert.equal(allOutput.includes(COMMITMENT_SECRET), false);
  assert.ok(io.logs.some((line) => line.startsWith("CHANNEL_CONTRACT=")));
  assert.ok(io.logs.includes(`FUNDER_ACCOUNT=${FUNDER_KEYPAIR.publicKey()}`));
});

test("runChannelCli open: fails cleanly without COMMITMENT_SECRET", async () => {
  const exitCode = await runChannelCli(
    ["node", "channel.ts", "open", "--deposit", "1"],
    baseEnv({ commitmentSecret: undefined }),
    fakePort(),
    fakeRecordStore(),
    fakeIO(),
  );
  assert.equal(exitCode, 1);
});

test("runChannelCli top-up: calls port.topUp and adds the amount to the cached record", async () => {
  const port = fakePort();
  const store = fakeRecordStore();
  store.write({
    v: 1,
    channel: CHANNEL,
    txHash: "open-hash",
    depositRaw: "1000",
    refundWaitingPeriodLedgers: 60,
    deployLedger: 1,
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
  const exitCode = await runChannelCli(["node", "channel.ts", "top-up", "--amount", "500"], baseEnv(), port, store, fakeIO());
  assert.equal(exitCode, 0);
  assert.deepEqual(port.calls.topUp[0], { channel: CHANNEL, amountRaw: 500n });
  assert.equal(store.records.at(-1)!.depositRaw, "1500");
});

test("runChannelCli requires CHANNEL_CONTRACT for top-up/close-start/refund/state", async () => {
  for (const command of ["top-up", "close-start", "refund", "state"]) {
    const argv = command === "top-up" ? ["node", "channel.ts", command, "--amount", "1"] : ["node", "channel.ts", command];
    const exitCode = await runChannelCli(argv, baseEnv({ channelContract: undefined }), fakePort(), fakeRecordStore(), fakeIO());
    assert.equal(exitCode, 1, `${command} should fail without CHANNEL_CONTRACT`);
  }
});

test("runChannelCli close-start/refund call the matching port method", async () => {
  const port = fakePort();
  await runChannelCli(["node", "channel.ts", "close-start"], baseEnv(), port, fakeRecordStore(), fakeIO());
  await runChannelCli(["node", "channel.ts", "refund"], baseEnv(), port, fakeRecordStore(), fakeIO());
  assert.deepEqual(port.calls.closeStart[0], { channel: CHANNEL });
  assert.deepEqual(port.calls.refund[0], { channel: CHANNEL });
});

test("runChannelCli state prints the getters and pending-dispute info", async () => {
  const port = fakePort({
    async state() {
      return {
        token: "TOKEN",
        from: "FROM",
        to: "TO",
        refundWaitingPeriodLedgers: 60,
        balanceRaw: 5_000_000n,
        depositedRaw: undefined,
        closeEffectiveAtLedger: 4_700_600,
        currentLedger: 4_700_500,
        pendingDispute: true,
      };
    },
  });
  const io = fakeIO();
  const exitCode = await runChannelCli(["node", "channel.ts", "state"], baseEnv(), port, fakeRecordStore(), io);
  assert.equal(exitCode, 0);
  const output = io.logs.join("\n");
  assert.match(output, /"pendingDispute":true/);
  assert.match(output, /"closeEffectiveAtLedger":4700600/);
  assert.match(output, /unavailable/);
});
