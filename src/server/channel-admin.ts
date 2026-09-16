// Operator CLI for the recipient/server side (WU7): `node
// src/server/channel-admin.ts <state|close>`. Used for the demo's "fin de
// viaje" — a human closes the channel on purpose, or checks its state
// without waiting for the close-monitor.

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { parseServerEnv } from "../config/env.ts";
import { buildServerChannelInstance } from "../config/boot.ts";
import { getChannelState } from "@stellar/mpp/channel/server";
import {
  getBalanceRaw,
  getChannelIdentity,
  tryGetDepositedRaw,
  type ChannelContractDeps,
} from "../shared/stellar/channel-contract.ts";

function bigintSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command !== "state" && command !== "close") {
    console.error(bigintSafeStringify({ level: "error", msg: `unknown subcommand "${command ?? ""}" — expected state or close` }));
    return 1;
  }

  const parsed = parseServerEnv(process.env);
  if (!parsed.ok) {
    console.error(bigintSafeStringify({ level: "error", msg: "invalid server configuration", detail: parsed.detail }));
    return 1;
  }
  const env = parsed.value;
  if (env.CHANNEL_CONTRACT === undefined || env.COMMITMENT_PUBKEY === undefined || env.FUNDER_ACCOUNT === undefined) {
    console.error(bigintSafeStringify({ level: "error", msg: "stage 2 is not configured (CHANNEL_CONTRACT/COMMITMENT_PUBKEY/FUNDER_ACCOUNT unset)" }));
    return 1;
  }
  const channel = env.CHANNEL_CONTRACT;

  const built = await buildServerChannelInstance({
    ...env,
    CHANNEL_CONTRACT: channel,
    COMMITMENT_PUBKEY: env.COMMITMENT_PUBKEY,
    FUNDER_ACCOUNT: env.FUNDER_ACCOUNT,
  });
  if (built.status !== "ready") {
    console.error(bigintSafeStringify({ level: "error", msg: "channel instance not ready", reason: built.reason, detail: built.detail }));
    return 1;
  }
  const { channelService } = built.instance;

  if (command === "state") {
    const channelDeps: ChannelContractDeps = { rpcUrl: env.SOROBAN_RPC_URL, network: env.STELLAR_NETWORK };
    const [identity, balanceRaw, depositedRaw, chainState] = await Promise.all([
      getChannelIdentity(channelDeps, channel),
      getBalanceRaw(channelDeps, channel),
      tryGetDepositedRaw(channelDeps, channel),
      getChannelState({ channel, network: env.STELLAR_NETWORK, rpcUrl: env.SOROBAN_RPC_URL }),
    ]);
    const pendingDispute =
      chainState.closeEffectiveAtLedger !== null && chainState.closeEffectiveAtLedger > chainState.currentLedger;
    console.log(
      bigintSafeStringify({
        level: "info",
        msg: "channel state",
        channel,
        token: identity.token,
        from: identity.from,
        to: identity.to,
        refundWaitingPeriodLedgers: identity.refundWaitingPeriodLedgers,
        balanceRaw,
        depositedRaw: depositedRaw ?? "unavailable (wasm has no deposited() getter — see docs/sdd/payments-mpp.md §6)",
        closeEffectiveAtLedger: chainState.closeEffectiveAtLedger,
        currentLedger: chainState.currentLedger,
        pendingDispute,
        serverHighestAcceptedRaw: channelService.getHighestRaw(channel),
      }),
    );
    return 0;
  }

  // close
  const outcome = await channelService.closeChannel(channel);
  console.log(bigintSafeStringify({ level: outcome.kind === "closed" ? "info" : "error", msg: "channel close", outcome }));
  return outcome.kind === "closed" ? 0 : 1;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      bigintSafeStringify({ level: "error", msg: "channel-admin failed", detail: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}
