// Funder-side channel CLI (WU6, T6.1): `node src/agent/channel.ts
// <open|top-up|close-start|refund|state>`. Ported from the spike scripts
// (scratchpad/spike/run-a-open-and-close-start.mjs,
// run-c-open-channel2.mjs, read-demo-channel.mjs) — those proved the exact
// on-chain call sequence; this file wraps them behind a testable `ChannelPort`
// so the argument parsing and record-writing logic (`runChannelCli`) never
// touches the network in tests.
//
// `open` never prints a secret: it prints `CHANNEL_CONTRACT=`,
// `COMMITMENT_PUBKEY=`, and `FUNDER_ACCOUNT=` (all public) for the operator
// to paste into `.env` (design 4.2), and nothing else.

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { getChannelState } from "@stellar/mpp/channel/server";
import {
  buildCloseStartTx,
  buildOpenChannelTx,
  buildRefundTx,
  buildTopUpTx,
  channelAddressFromOpenResult,
  commitmentKeypairFromSecret,
  feeChargedOf,
  getBalanceRaw,
  getChannelIdentity,
  prepareSignSendPoll,
  tryGetDepositedRaw,
  type ChannelContractDeps,
} from "../shared/stellar/channel-contract.ts";
import {
  channelRecordPath,
  readChannelRecord,
  writeChannelRecord,
  type ChannelRecord,
} from "../persistence/channel-record.ts";
import { parseNonNegativeIntegerRaw } from "../shared/money.ts";
import type { Network } from "../shared/stellar/network.ts";

export type ChannelOpenResult = { channel: string; txHash: string; deployLedger: number; feeChargedStroops: string };
export type ChannelTxResult = { txHash: string; feeChargedStroops: string };
export type ChannelStateSummary = {
  token: string;
  from: string;
  to: string;
  refundWaitingPeriodLedgers: number;
  balanceRaw: bigint;
  depositedRaw: bigint | undefined;
  closeEffectiveAtLedger: number | null;
  currentLedger: number;
  pendingDispute: boolean;
};

/** The one seam between CLI orchestration (`runChannelCli`, fully testable)
 * and the real Stellar SDK (`createRealChannelPort`, entrypoint-only). */
export type ChannelPort = {
  open(params: {
    depositRaw: bigint;
    waitingPeriodLedgers: number;
    commitmentPubkeyHex: string;
  }): Promise<ChannelOpenResult>;
  topUp(params: { channel: string; amountRaw: bigint }): Promise<ChannelTxResult>;
  closeStart(params: { channel: string }): Promise<ChannelTxResult>;
  refund(params: { channel: string }): Promise<ChannelTxResult>;
  state(params: { channel: string }): Promise<ChannelStateSummary>;
};

/** Injectable record persistence (testable without touching the filesystem). */
export type ChannelRecordStore = {
  read(): ChannelRecord | undefined;
  write(record: ChannelRecord): void;
};

export type CliIO = {
  log(line: string): void;
  error(line: string): void;
  now(): Date;
};

export type CliEnv = {
  funderSecret: string;
  recipientPublicKey: string;
  usdcContract: string;
  commitmentSecret?: string;
  channelContract?: string;
  network: Network;
};

export type ParsedArgs =
  | { command: "open"; depositRaw: bigint; waitingPeriodLedgers: number }
  | { command: "top-up"; amountRaw: bigint }
  | { command: "close-start" }
  | { command: "refund" }
  | { command: "state" }
  | { command: "error"; detail: string };

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const DEFAULT_WAITING_PERIOD_LEDGERS = 60;

/** Pure argv parser (T6.1: "ChannelPort fake — __constructor/top_up
 * invocados con los argumentos correctos"). `argv` is the full
 * `process.argv`-shaped array (`[node, script, subcommand, ...flags]`). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[2];
  if (command === "open") {
    const depositStr = flagValue(argv, "--deposit");
    if (depositStr === undefined) return { command: "error", detail: "open requires --deposit <raw>" };
    const depositRaw = parseNonNegativeIntegerRaw(depositStr);
    if (depositRaw === undefined || depositRaw === 0n) {
      return { command: "error", detail: `--deposit must be a positive integer, got "${depositStr}"` };
    }
    const waitingPeriodStr = flagValue(argv, "--waiting-period");
    const waitingPeriodLedgers =
      waitingPeriodStr === undefined ? DEFAULT_WAITING_PERIOD_LEDGERS : Number(waitingPeriodStr);
    if (!Number.isInteger(waitingPeriodLedgers) || waitingPeriodLedgers <= 0) {
      return { command: "error", detail: `--waiting-period must be a positive integer, got "${waitingPeriodStr}"` };
    }
    return { command: "open", depositRaw, waitingPeriodLedgers };
  }
  if (command === "top-up") {
    const amountStr = flagValue(argv, "--amount");
    if (amountStr === undefined) return { command: "error", detail: "top-up requires --amount <raw>" };
    const amountRaw = parseNonNegativeIntegerRaw(amountStr);
    if (amountRaw === undefined || amountRaw === 0n) {
      return { command: "error", detail: `--amount must be a positive integer, got "${amountStr}"` };
    }
    return { command: "top-up", amountRaw };
  }
  if (command === "close-start") return { command: "close-start" };
  if (command === "refund") return { command: "refund" };
  if (command === "state") return { command: "state" };
  return {
    command: "error",
    detail: `unknown subcommand "${command ?? ""}" — expected one of: open, top-up, close-start, refund, state`,
  };
}

/**
 * Orchestrates one CLI invocation against a `ChannelPort` + `ChannelRecordStore`
 * (both injectable — this function never touches the network or the
 * filesystem directly, T6.1). Returns the process exit code.
 */
export async function runChannelCli(
  argv: readonly string[],
  env: CliEnv,
  port: ChannelPort,
  recordStore: ChannelRecordStore,
  io: CliIO,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "error") {
    io.error(JSON.stringify({ level: "error", msg: parsed.detail }));
    return 1;
  }

  if (parsed.command === "open") {
    if (env.commitmentSecret === undefined) {
      io.error(JSON.stringify({ level: "error", msg: "COMMITMENT_SECRET must be set to open a channel" }));
      return 1;
    }
    const commitmentPubkeyHex = Buffer.from(
      commitmentKeypairFromSecret(env.commitmentSecret).rawPublicKey(),
    ).toString("hex");
    const result = await port.open({
      depositRaw: parsed.depositRaw,
      waitingPeriodLedgers: parsed.waitingPeriodLedgers,
      commitmentPubkeyHex,
    });
    recordStore.write({
      v: 1,
      channel: result.channel,
      txHash: result.txHash,
      depositRaw: parsed.depositRaw.toString(),
      refundWaitingPeriodLedgers: parsed.waitingPeriodLedgers,
      deployLedger: result.deployLedger,
      updatedAt: io.now().toISOString(),
    });
    io.log(
      JSON.stringify({
        level: "info",
        msg: "channel opened",
        txHash: result.txHash,
        feeChargedStroops: result.feeChargedStroops,
      }),
    );
    // Design 4.2: prints exactly the .env lines an operator pastes in — all
    // public values, never a secret.
    io.log(`CHANNEL_CONTRACT=${result.channel}`);
    io.log(`COMMITMENT_PUBKEY=${commitmentPubkeyHex}`);
    io.log(`FUNDER_ACCOUNT=${Keypair.fromSecret(env.funderSecret).publicKey()}`);
    return 0;
  }

  if (env.channelContract === undefined) {
    io.error(JSON.stringify({ level: "error", msg: "CHANNEL_CONTRACT must be set for this subcommand" }));
    return 1;
  }
  const channel = env.channelContract;

  if (parsed.command === "top-up") {
    const result = await port.topUp({ channel, amountRaw: parsed.amountRaw });
    const previous = recordStore.read();
    if (previous !== undefined && previous.channel === channel) {
      recordStore.write({
        ...previous,
        depositRaw: (BigInt(previous.depositRaw) + parsed.amountRaw).toString(),
        updatedAt: io.now().toISOString(),
      });
    }
    io.log(JSON.stringify({ level: "info", msg: "top-up sent", txHash: result.txHash }));
    return 0;
  }

  if (parsed.command === "close-start") {
    const result = await port.closeStart({ channel });
    io.log(JSON.stringify({ level: "info", msg: "close_start sent", txHash: result.txHash }));
    return 0;
  }

  if (parsed.command === "refund") {
    const result = await port.refund({ channel });
    io.log(JSON.stringify({ level: "info", msg: "refund sent", txHash: result.txHash }));
    return 0;
  }

  // state
  const state = await port.state({ channel });
  io.log(
    JSON.stringify({
      level: "info",
      msg: "channel state",
      channel,
      token: state.token,
      from: state.from,
      to: state.to,
      refundWaitingPeriodLedgers: state.refundWaitingPeriodLedgers,
      balanceRaw: state.balanceRaw.toString(),
      depositedRaw: state.depositedRaw !== undefined ? state.depositedRaw.toString() : "unavailable (wasm has no deposited() getter — see docs/sdd/payments-mpp.md §6)",
      closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      currentLedger: state.currentLedger,
      pendingDispute: state.pendingDispute,
    }),
  );
  return 0;
}

/** Real, SDK-backed `ChannelPort` (entrypoint-only — never imported by
 * `runChannelCli`'s tests). */
export function createRealChannelPort(env: CliEnv, rpcUrl: string): ChannelPort {
  const deps: ChannelContractDeps = { rpcUrl, network: env.network };
  const funderKeypair = Keypair.fromSecret(env.funderSecret);

  return {
    async open(params) {
      const tx = await buildOpenChannelTx(deps, {
        funderPublicKey: funderKeypair.publicKey(),
        recipientPublicKey: env.recipientPublicKey,
        tokenContract: env.usdcContract,
        commitmentPubkeyHex: params.commitmentPubkeyHex,
        depositRaw: params.depositRaw,
        refundWaitingPeriodLedgers: params.waitingPeriodLedgers,
      });
      const { hash, result } = await prepareSignSendPoll(deps, tx, [funderKeypair]);
      if (result.status !== "SUCCESS") {
        throw new Error(`open failed: ${JSON.stringify(result)}`.slice(0, 2000));
      }
      const channel = channelAddressFromOpenResult(result);
      return {
        channel,
        txHash: hash,
        deployLedger: result.ledger,
        feeChargedStroops: feeChargedOf(result),
      };
    },
    async topUp(params) {
      const tx = await buildTopUpTx(deps, funderKeypair.publicKey(), params.channel, params.amountRaw);
      const { hash, result } = await prepareSignSendPoll(deps, tx, [funderKeypair]);
      if (result.status !== "SUCCESS") throw new Error(`top_up failed: ${JSON.stringify(result)}`.slice(0, 2000));
      return { txHash: hash, feeChargedStroops: feeChargedOf(result) };
    },
    async closeStart(params) {
      const tx = await buildCloseStartTx(deps, funderKeypair.publicKey(), params.channel);
      const { hash, result } = await prepareSignSendPoll(deps, tx, [funderKeypair]);
      if (result.status !== "SUCCESS") throw new Error(`close_start failed: ${JSON.stringify(result)}`.slice(0, 2000));
      return { txHash: hash, feeChargedStroops: feeChargedOf(result) };
    },
    async refund(params) {
      const tx = await buildRefundTx(deps, funderKeypair.publicKey(), params.channel);
      const { hash, result } = await prepareSignSendPoll(deps, tx, [funderKeypair]);
      if (result.status !== "SUCCESS") throw new Error(`refund failed: ${JSON.stringify(result)}`.slice(0, 2000));
      return { txHash: hash, feeChargedStroops: feeChargedOf(result) };
    },
    async state(params) {
      const [identity, balanceRaw, depositedRaw, chainState] = await Promise.all([
        getChannelIdentity(deps, params.channel),
        getBalanceRaw(deps, params.channel),
        tryGetDepositedRaw(deps, params.channel),
        getChannelState({ channel: params.channel, network: env.network, rpcUrl }),
      ]);
      const pendingDispute =
        chainState.closeEffectiveAtLedger !== null && chainState.closeEffectiveAtLedger > chainState.currentLedger;
      return {
        token: identity.token,
        from: identity.from,
        to: identity.to,
        refundWaitingPeriodLedgers: identity.refundWaitingPeriodLedgers,
        balanceRaw,
        depositedRaw,
        closeEffectiveAtLedger: chainState.closeEffectiveAtLedger,
        currentLedger: chainState.currentLedger,
        pendingDispute,
      };
    },
  };
}

function readCliEnv(): CliEnv {
  const funderSecret = process.env.SIGNER_SECRET;
  const recipientPublicKey = process.env.STELLAR_RECIPIENT;
  const usdcContract = process.env.USDC_SAC_CONTRACT ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const network = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as Network;
  if (funderSecret === undefined || funderSecret === "") {
    throw new Error("SIGNER_SECRET must be set (the funder's Stellar secret key)");
  }
  if (recipientPublicKey === undefined || recipientPublicKey === "") {
    throw new Error("STELLAR_RECIPIENT must be set (the channel's recipient account)");
  }
  return {
    funderSecret,
    recipientPublicKey,
    usdcContract,
    network,
    ...(process.env.COMMITMENT_SECRET ? { commitmentSecret: process.env.COMMITMENT_SECRET } : {}),
    ...(process.env.CHANNEL_CONTRACT ? { channelContract: process.env.CHANNEL_CONTRACT } : {}),
  };
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const dataDir = process.env.DATA_DIR ?? "./data";
  try {
    const env = readCliEnv();
    const port = createRealChannelPort(env, rpcUrl);
    const recordPath = channelRecordPath(dataDir, env.network);
    const recordStore: ChannelRecordStore = {
      read: () => readChannelRecord(recordPath),
      write: (record) => writeChannelRecord(recordPath, record),
    };
    const exitCode = await runChannelCli(process.argv, env, port, recordStore, {
      log: (line) => process.stdout.write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`),
      now: () => new Date(),
    });
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", msg: "channel CLI failed", detail: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
