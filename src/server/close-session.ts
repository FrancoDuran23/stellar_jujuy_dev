// Operator CLI for the Citrus trip-closing walk (docs/citrus-mobile-spec.md v2
// §7 R9/T7): `node src/server/close-session.ts <iccid> [--wait]`.
//
// Requires CONNECTIVITY_PROVIDER=citrus and a stage-2 channel config (the same
// gates channel-admin.ts enforces). WITHOUT `--wait` it advances one step and
// prints where the walk stands; WITH `--wait` it polls `SessionCloser.runOnce`
// until the walk ends or `CITRUS_DEFUND_TIMEOUT_MS` elapses (a defund settles
// in ~15 min, C4).
//
// The final voucher (R9 step 4) is requested through the meter the CLI builds:
// with AGENT_VOUCHERS_URL + GATEWAY_TOKEN it hits the REAL agent (which
// delivers the voucher to the payment server, recording it as the highest
// accepted); without them it falls back to the in-memory double with a loud
// warning (demo/offline only).

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { parseServerEnv, type ServerEnv } from "../config/env.ts";
import { buildServerChannelInstance, createServerChannelStatePort } from "../config/boot.ts";
import { createConnectivityProvider } from "../providers/connectivity/createConnectivityProvider.ts";
import {
  IntegratedMeterService,
  createStellarChannelBalanceAdapter,
} from "../meter/meter-service.ts";
import { createAgentVoucherPort, createInMemoryVoucherPort, type VoucherPort } from "../meter/voucher-port.ts";
import { createConnectivitySession } from "../models/ConnectivitySession.ts";
import { SessionCloser, type SessionCloseResult } from "../services/SessionCloser.ts";

function bigintSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The final voucher goes to the REAL agent when both variables are set;
 * otherwise the in-memory double with a warning (the deposit it needs comes
 * from the channel's on-chain state, best effort — a transport failure
 * degrades to deposit 0). Never throws. */
async function resolveVoucherSetup(env: ServerEnv): Promise<{ voucherPort: VoucherPort; mode: "agent" | "inmem" }> {
  const url = envValue(process.env, "AGENT_VOUCHERS_URL");
  const token = envValue(process.env, "GATEWAY_TOKEN");
  if (url !== undefined && token !== undefined) {
    return { voucherPort: createAgentVoucherPort({ url, gatewayToken: token }), mode: "agent" };
  }
  if (url !== undefined || token !== undefined) {
    throw new Error(
      "AGENT_VOUCHERS_URL/GATEWAY_TOKEN deben definirse juntos para pedir el último vale al agente real",
    );
  }
  if (env.CHANNEL_CONTRACT === undefined) {
    throw new Error("stage 2 no está configurado (CHANNEL_CONTRACT unset)");
  }
  const statePort = createServerChannelStatePort(env);
  try {
    const info = await statePort.getChannelInfo(env.CHANNEL_CONTRACT);
    return {
      voucherPort: createInMemoryVoucherPort({ depositRaw: info.found ? info.depositRaw : 0n }),
      mode: "inmem",
    };
  } catch {
    return { voucherPort: createInMemoryVoucherPort({ depositRaw: 0n }), mode: "inmem" };
  }
}

async function main(): Promise<number> {
  const iccid = process.argv[2];
  const wait = process.argv.includes("--wait");
  if (iccid === undefined) {
    console.error(
      bigintSafeStringify({ level: "error", msg: "uso: node src/server/close-session.ts <iccid> [--wait]" }),
    );
    return 1;
  }

  const parsed = parseServerEnv(process.env);
  if (!parsed.ok) {
    console.error(bigintSafeStringify({ level: "error", msg: "invalid server configuration", detail: parsed.detail }));
    return 1;
  }
  const env = parsed.value;
  if (env.STELLAR_NETWORK === "stellar:pubnet") {
    console.error(
      bigintSafeStringify({
        level: "error",
        msg: "refusing to run against stellar:pubnet — this CLI is for stellar:testnet demos only",
      }),
    );
    return 1;
  }
  if (env.CONNECTIVITY_PROVIDER !== "citrus") {
    console.error(
      bigintSafeStringify({
        level: "error",
        msg: "close-session requires CONNECTIVITY_PROVIDER=citrus (the closing walk talks to the real backend)",
      }),
    );
    return 1;
  }
  if (
    env.CHANNEL_CONTRACT === undefined ||
    env.COMMITMENT_PUBKEY === undefined ||
    env.FUNDER_ACCOUNT === undefined
  ) {
    console.error(
      bigintSafeStringify({
        level: "error",
        msg: "stage 2 is not configured (CHANNEL_CONTRACT/COMMITMENT_PUBKEY/FUNDER_ACCOUNT unset)",
      }),
    );
    return 1;
  }
  if (env.PRICE_PER_MB_RAW === undefined) {
    console.error(
      bigintSafeStringify({ level: "error", msg: "PRICE_PER_MB_RAW unset — required with CONNECTIVITY_PROVIDER=citrus" }),
    );
    return 1;
  }
  const pricePerMbRaw: bigint = env.PRICE_PER_MB_RAW;

  const connectivity = createConnectivityProvider({ ...env, PRICE_PER_MB_RAW: pricePerMbRaw });
  const row = connectivity.esimStore.get(iccid);
  if (row === undefined) {
    console.error(bigintSafeStringify({ level: "error", msg: `no hay registro local para la eSIM ${iccid}` }));
    return 1;
  }

  const built = await buildServerChannelInstance({
    ...env,
    CHANNEL_CONTRACT: env.CHANNEL_CONTRACT,
    COMMITMENT_PUBKEY: env.COMMITMENT_PUBKEY,
    FUNDER_ACCOUNT: env.FUNDER_ACCOUNT,
  });
  if (built.status !== "ready") {
    console.error(
      bigintSafeStringify({
        level: "error",
        msg: "channel instance not ready",
        reason: built.reason,
        detail: built.detail,
      }),
    );
    return 1;
  }
  const { channelService } = built.instance;

  const setup = await resolveVoucherSetup(env);
  if (setup.mode === "inmem") {
    console.error(
      bigintSafeStringify({
        level: "warn",
        msg: "AGENT_VOUCHERS_URL/GATEWAY_TOKEN no definidos — el último vale se pide al doble en memoria (OFFLINE). Para el flujo real definí ambas.",
      }),
    );
  }

  const session = createConnectivitySession({
    id: `close_${iccid}`,
    userId: row.userRef,
    iccid,
    channelId: row.channelId,
  });
  const meter = new IntegratedMeterService({
    session,
    provider: connectivity.provider,
    balancePort: createStellarChannelBalanceAdapter(createServerChannelStatePort(env)),
    voucherPort: setup.voucherPort,
    network: env.STELLAR_NETWORK,
    voucherPricePerMibRaw: env.PRICE_PER_MIB_RAW,
    pricePerMbRaw,
    logger: (msg) => console.error(`   ${msg}`),
  });

  const closer = new SessionCloser({
    provider: connectivity.provider,
    esimStore: connectivity.esimStore,
    meter,
    closeChannel: (channelId) => channelService.closeChannel(channelId),
    markupBps: env.MARKUP_BPS,
    usdcUsdRateBps: env.USDC_USD_RATE_BPS,
    pricePerMbRaw,
    pollIntervalMs: 5000,
    stableWindowMs: env.CITRUS_DEFUND_STABLE_WINDOW_MS,
  });

  const started = await closer.beginClose(iccid);
  if (!started.started) {
    console.error(
      bigintSafeStringify({ level: "error", msg: "no se pudo iniciar el cierre", detail: started.reason }),
    );
    return started.reason === "no_row" ? 1 : 0;
  }

  const deadline = Date.now() + env.CITRUS_DEFUND_TIMEOUT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result: SessionCloseResult = await closer.runOnce(iccid);
    console.log(bigintSafeStringify({ level: "info", msg: "paso de cierre", ...result }));
    if (result.step === "done") return 0;
    if (result.step === null) {
      console.error(
        bigintSafeStringify({ level: "error", msg: "cierre sin progreso", skipped: result.skipped }),
      );
      return 1;
    }
    if (!wait) return 0;
    if (result.step === "defund_liquidado" && Date.now() > deadline) {
      console.error(
        bigintSafeStringify({
          level: "error",
          msg: `defund no liquidado dentro de CITRUS_DEFUND_TIMEOUT_MS=${env.CITRUS_DEFUND_TIMEOUT_MS}ms — revisá el dashboard de Citrus`,
        }),
      );
      return 1;
    }
    await sleep(5000);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      bigintSafeStringify({
        level: "error",
        msg: "close-session failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}