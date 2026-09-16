// Fail-closed boot orchestration (design 4.5; spec 3.5, FC-R1..FC-R8, T4.1).
//
// `app.listen()` must happen in `server/main.ts` BEFORE anything in this
// module ever runs (FC-R1) — this module only builds/rebuilds the payment
// instance and reports its state. It never calls `process.exit` (FC-R2) and
// nothing here blocks the initial `listen()` call: `createServerBoot()`
// returns synchronously and the first build attempt is kicked off by the
// caller (`server/main.ts`) as a fire-and-forget after the port is already
// accepting connections.
//
// This is also where the Stellar/mppx SDK is instantiated for the server
// role (design 4.1's testability rule: the SDK lives *only* in
// `config/boot.ts` and `agent/charge-client.ts` — everywhere else takes a
// port as an argument).

import path from "node:path";
import { Keypair, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { Mppx, Store, stellar } from "@stellar/mpp/charge/server";
import { fromBaseUnits } from "@stellar/mpp";
import { Receipt } from "mppx";
import type { ChargeOutcome, ChargePort } from "../server/charge-service.ts";
import { parseServerEnv, parseAgentEnv, type ServerEnv, type AgentEnv } from "./env.ts";
import { isReason, type Reason } from "../shared/reasons.ts";
import type { EmitInput } from "../shared/events.ts";
import { VoucherLog } from "../persistence/voucher-log.ts";
import { channelRecordPath, readChannelRecord } from "../persistence/channel-record.ts";
import {
  createVoucherService,
  createStaticDepositPort,
  type VoucherService,
  type ChannelDepositPort,
} from "../agent/routes/vouchers.ts";
import { createFakeSigner, type SignerPort } from "../agent/signer.ts";
import { createChannelCache, type ChannelRpcPort } from "../agent/channel-cache.ts";
import {
  assertCommitmentBinds,
  prepareCommitmentBytes,
  signCommitmentBytes,
  tryGetDepositedRaw,
  type ChannelContractDeps,
} from "../shared/stellar/channel-contract.ts";
import { getChannelState } from "@stellar/mpp/channel/server";

const AMOUNT_DECIMALS = 7;

/**
 * Reasons an instance can be `unavailable` for that are NOT part of the M2
 * vocabulary (design 4.5: `config_invalid` is an alarm-only reason, never
 * sent to the gateway). `/ready` shows this raw, specific reason; a
 * payment-route 503 always maps it to a valid M2 `Reason` via `toM2Reason`
 * below, so the gateway's `REASONS` table is never asked to recognize a
 * value it does not define (FT-R6/FT-R7).
 */
export type UnavailableReason = Reason | "config_invalid" | "voucher_log_corrupt";

export type BuildResult<T> =
  | { status: "ready"; instance: T }
  | { status: "unavailable"; reason: UnavailableReason; detail: string };

/** Maps an alarm-only reason to the closest M2-safe `Reason` (FC-R5). */
export function toM2Reason(reason: UnavailableReason): Reason {
  return isReason(reason) ? reason : "internal_error";
}

export type FailClosedBoot<T> = {
  getState(): BuildResult<T>;
  /**
   * Re-arms the instance if it is not ready. The FIRST call always attempts;
   * later calls are throttled to at most one real attempt every
   * `retryIntervalMs` (FC-R8) — concurrent callers during a throttle window
   * or a still-running attempt all observe the same in-flight promise, so a
   * burst of requests can never trigger a burst of rebuilds.
   */
  ensureReady(): Promise<BuildResult<T>>;
};

/**
 * Generic fail-closed re-arm wrapper — no SDK, no env, fully unit-testable
 * with a fake `buildInstance` (T4.3).
 */
export function createFailClosedBoot<T>(options: {
  buildInstance: () => Promise<BuildResult<T>>;
  retryIntervalMs: number;
  now?: () => number;
}): FailClosedBoot<T> {
  const now = options.now ?? Date.now;
  let state: BuildResult<T> = {
    status: "unavailable",
    reason: "internal_error",
    detail: "payment instance not initialized yet",
  };
  let lastAttemptAt = -Infinity;
  let inFlight: Promise<BuildResult<T>> | null = null;

  function attempt(): Promise<BuildResult<T>> {
    if (inFlight) return inFlight;
    inFlight = options
      .buildInstance()
      .catch(
        (error: unknown): BuildResult<T> => ({
          status: "unavailable",
          reason: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((result) => {
        state = result;
        lastAttemptAt = now();
        inFlight = null;
        return result;
      });
    return inFlight;
  }

  return {
    getState: () => state,
    async ensureReady() {
      if (state.status === "ready") return state;
      if (now() - lastAttemptAt < options.retryIntervalMs) return state;
      return attempt();
    },
  };
}

export type RpcHealthPort = {
  /** Resolves `true` iff the RPC responded within its own timeout budget. */
  check(): Promise<boolean>;
};

/** Real Soroban RPC health probe (FC-R4): bounded to `timeoutMs`. */
export function createSorobanRpcHealthPort(rpcUrl: string, timeoutMs: number): RpcHealthPort {
  return {
    async check() {
      const server = new StellarRpc.Server(rpcUrl);
      try {
        await Promise.race([
          server.getHealth(),
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("Soroban RPC health check timed out")), timeoutMs);
          }),
        ]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the real, SDK-backed `ChargePort` for stage 1 (S1-R2). Assumes
 * `env` already passed `parseServerEnv` — this function itself only does the
 * FC-R4 RPC health check and the mppx/Stellar wiring, both inside a
 * try/catch so a construction-time throw becomes `unavailable`, never an
 * uncaught rejection (FC-R2).
 *
 * Spike S3 finding (recorded in docs/sdd/payments-mpp.md §6): the settled
 * `txHash` is read from the `Payment-Receipt` response header via
 * `Receipt.fromResponse()` (exported by `mppx`), not from an event listener
 * or a hand-computed envelope hash. `respondReceipt()` for the HTTP
 * transport is a pure header-attaching function over an already-computed
 * receipt, so calling `result.withReceipt()` a second time — once to read
 * the receipt, once to attach it to our real JSON body — is side-effect
 * free; the actual on-chain broadcast already happened before `verify()`
 * returned.
 */
export async function buildServerChargeInstance(
  env: ServerEnv,
  deps: { rpcHealthPort?: RpcHealthPort } = {},
): Promise<BuildResult<ChargePort>> {
  const rpcHealthPort =
    deps.rpcHealthPort ?? createSorobanRpcHealthPort(env.SOROBAN_RPC_URL, env.RPC_HEALTH_TIMEOUT_MS);

  const healthy = await rpcHealthPort.check();
  if (!healthy) {
    return {
      status: "unavailable",
      reason: "upstream_unavailable",
      detail: `Soroban RPC at ${env.SOROBAN_RPC_URL} did not respond within ${env.RPC_HEALTH_TIMEOUT_MS}ms`,
    };
  }

  try {
    const envelopeSigner = Keypair.fromSecret(env.FEE_PAYER_SECRET);
    const mppx = Mppx.create({
      secretKey: env.MPP_SECRET_KEY,
      methods: [
        stellar.charge({
          recipient: env.STELLAR_RECIPIENT,
          currency: env.USDC_SAC_CONTRACT,
          network: env.STELLAR_NETWORK,
          rpcUrl: env.SOROBAN_RPC_URL,
          feePayer: { envelopeSigner },
          store: Store.memory(),
        }),
      ],
    });

    const chargePort: ChargePort = {
      async handle(request, params): Promise<ChargeOutcome> {
        const decimalAmount = fromBaseUnits(params.amountRaw, AMOUNT_DECIMALS);
        let result: Awaited<ReturnType<ReturnType<typeof mppx.charge>>>;
        try {
          result = await mppx.charge({
            amount: decimalAmount,
            ...(params.description !== undefined ? { description: params.description } : {}),
          })(request);
        } catch (error) {
          return { kind: "failed", reason: "internal_error", detail: messageOf(error) };
        }

        if (result.status === 402) {
          return { kind: "challenge", response: result.challenge };
        }

        let txHash: string;
        try {
          // Throwaway probe: `withReceipt` only attaches the already-computed
          // receipt as a header (see doc comment above) — this never
          // re-submits or re-verifies anything.
          const probe = result.withReceipt(new Response(null));
          txHash = Receipt.fromResponse(probe).reference;
        } catch (error) {
          return {
            kind: "failed",
            reason: "internal_error",
            detail: `payment settled but its receipt could not be read: ${messageOf(error)}`,
          };
        }

        return {
          kind: "settled",
          txHash,
          buildResponse: (body) =>
            result.withReceipt(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
        };
      },
    };

    return { status: "ready", instance: chargePort };
  } catch (error) {
    return { status: "unavailable", reason: "config_invalid", detail: messageOf(error) };
  }
}

/**
 * Real, `COMMITMENT_SECRET`-backed `SignerPort` (WU6, T6.2). Simulates
 * `prepare_commitment(amount)` on the channel (free, read-only — spike Part
 * A/C), verifies the returned XDR map binds to the expected
 * channel/amount/network (the same defense `@stellar/mpp`'s client applies
 * before ever signing), then ed25519-signs with the raw 32-byte seed. The
 * SDK itself is only touched here and in `agent/charge-client.ts`
 * (design 4.1's testability rule) via the thin `shared/stellar/
 * channel-contract.ts` driver — this function has no business logic of its
 * own.
 */
export function createRealChannelSigner(
  commitmentSecretHex: string,
  channelDeps: ChannelContractDeps,
): SignerPort {
  return {
    async sign(input) {
      const amount = BigInt(input.cumulativeAmount);
      const bytes = await prepareCommitmentBytes(channelDeps, input.channel, amount);
      assertCommitmentBinds(bytes, { channel: input.channel, amount, network: channelDeps.network });
      return signCommitmentBytes(commitmentSecretHex, bytes);
    },
  };
}

/**
 * Real, contract-backed `ChannelRpcPort` (WU6, T6.3's underlying driver).
 * Every call is wrapped so a Soroban RPC hiccup never throws past this
 * function (the spike's XDR crash finding, docs/sdd/payments-mpp.md §6: any
 * RPC call in a request-serving path must degrade to a typed result, never
 * crash the process) — a failure here simply reports `{found: false}`,
 * which `agent/routes/vouchers.ts` turns into `channel_not_found`.
 *
 * `deposited()` is missing on the only wasm revision deployable today
 * (spike Part C) — falls back to the locally tracked `data/channel-
 * {network}.json` record (written by `agent/channel.ts`'s `open`/`top-up`
 * subcommands), and as a last resort to the on-chain `balance` (a safe
 * lower bound: it under-reports remaining budget rather than over-reporting
 * it). `closing` comes from `@stellar/mpp/channel/server`'s `getChannelState()`
 * (`closeEffectiveAtLedger !== null`), which already knows how to read the
 * contract's `CloseEffectiveAtLedger` instance-storage entry directly (no
 * getter exists for it — spike Part B).
 */
export function createStellarChannelRpcPort(env: {
  SOROBAN_RPC_URL: string;
  STELLAR_NETWORK: ChannelContractDeps["network"];
  DATA_DIR: string;
}): ChannelRpcPort {
  const channelDeps: ChannelContractDeps = { rpcUrl: env.SOROBAN_RPC_URL, network: env.STELLAR_NETWORK };
  return {
    async getContractChannelInfo(channel) {
      try {
        const state = await getChannelState({
          channel,
          network: env.STELLAR_NETWORK,
          rpcUrl: env.SOROBAN_RPC_URL,
        });
        const closing = state.closeEffectiveAtLedger !== null;
        let depositRaw = await tryGetDepositedRaw(channelDeps, channel);
        if (depositRaw === undefined) {
          const record = readChannelRecord(channelRecordPath(env.DATA_DIR, env.STELLAR_NETWORK));
          depositRaw = record !== undefined && record.channel === channel ? BigInt(record.depositRaw) : state.balance;
        }
        return { found: true, depositRaw, closing };
      } catch {
        return { found: false };
      }
    },
  };
}

const DEFAULT_INIT_RETRY_INTERVAL_MS = 10_000;

/**
 * Composes env parsing + the real charge instance builder + the fail-closed
 * re-arm wrapper into the single `FailClosedBoot<ChargePort>` that
 * `server/main.ts` and `requireReady` share.
 *
 * `retryIntervalMs` uses the design default (10s) rather than the parsed
 * `INIT_RETRY_INTERVAL_MS` env value: that value is only known once parsing
 * has already succeeded once, and re-reading it on every attempt would let a
 * config typo change its own retry cadence. Documented simplification — see
 * docs/sdd/payments-mpp.md §6.
 */
export function createServerBoot(options?: {
  rawEnv?: Record<string, string | undefined>;
  retryIntervalMs?: number;
  buildChargeInstance?: (env: ServerEnv) => Promise<BuildResult<ChargePort>>;
  now?: () => number;
}): FailClosedBoot<ChargePort> {
  const rawEnv = options?.rawEnv ?? process.env;
  const buildChargeInstance = options?.buildChargeInstance ?? buildServerChargeInstance;

  return createFailClosedBoot<ChargePort>({
    retryIntervalMs: options?.retryIntervalMs ?? DEFAULT_INIT_RETRY_INTERVAL_MS,
    ...(options?.now !== undefined ? { now: options.now } : {}),
    buildInstance: async () => {
      const parsed = parseServerEnv(rawEnv);
      if (!parsed.ok) {
        return { status: "unavailable", reason: "config_invalid", detail: parsed.detail };
      }
      return buildChargeInstance(parsed.value);
    },
  });
}

/**
 * Builds the agent's `POST /vouchers` instance (WU5, T5.3 deviation — Lote
 * C): opens the voucher log and wires it into `createVoucherService`.
 *
 * This is where batch B's deviation 6 gets closed: FC-R3 lists "voucher log
 * no abrible en modo append" as one of the three conditions that must make
 * the instance `unavailable`. `VoucherLog.open()` returning `status:
 * "corrupt"` (a corrupt line that is not the last one, VP-R6) is exactly
 * that condition for the agent role — it is turned into `unavailable` with
 * `reason: "voucher_log_corrupt"` here, the same way `buildServerChargeInstance`
 * turns a failed RPC health check into `unavailable`.
 *
 * The real ed25519 signer and the real contract-backed deposit tracker are
 * WU6 work (`agent/channel-cache.ts`, a `COMMITMENT_SECRET`-based signer in
 * this same file, mirroring how the server's SDK objects are built here and
 * nowhere else). Until then this always wires the fake signer and a static
 * deposit — both injectable via `deps` so tests never touch the filesystem
 * for anything but the voucher log itself (design 4.7: persistence is the
 * one thing never mocked).
 */
export async function buildAgentVouchersInstance(
  env: AgentEnv,
  deps: {
    voucherLogPath?: string;
    signer?: SignerPort;
    depositPort?: ChannelDepositPort;
    /** Forwarded to `createVoucherService` (`agent/main.ts`'s `serve` mode
     * passes the webhook-enabled emitter, same pattern as
     * `createServerBoot`/`server/main.ts`). Defaults to stdout-only `emit()`. */
    emit?: (input: EmitInput) => void;
  } = {},
): Promise<BuildResult<VoucherService>> {
  const voucherLogPath =
    deps.voucherLogPath ?? path.join(env.DATA_DIR, `vouchers-agent-${env.STELLAR_NETWORK}.jsonl`);

  let opened: ReturnType<typeof VoucherLog.open>;
  try {
    opened = VoucherLog.open(voucherLogPath);
  } catch (error) {
    return { status: "unavailable", reason: "voucher_log_corrupt", detail: messageOf(error) };
  }
  if (opened.status === "corrupt") {
    return { status: "unavailable", reason: opened.reason, detail: opened.detail };
  }

  // Stage-2 gate (config/env.ts's superRefine): CHANNEL_CONTRACT set implies
  // COMMITMENT_SECRET is also set, so this narrowing is safe. Below that
  // gate, behavior is byte-for-byte the stage-1.5 fake wiring (Lote C/D) —
  // no deployment loses its existing behavior by upgrading past WU6.
  const stage2 = env.CHANNEL_CONTRACT !== undefined && env.COMMITMENT_SECRET !== undefined;
  const channelDeps: ChannelContractDeps = { rpcUrl: env.SOROBAN_RPC_URL, network: env.STELLAR_NETWORK };
  const defaultSigner = stage2
    ? createRealChannelSigner(env.COMMITMENT_SECRET!, channelDeps)
    : createFakeSigner();
  const defaultDepositPort = stage2
    ? createChannelCache(createStellarChannelRpcPort(env))
    : createStaticDepositPort();

  const service = createVoucherService({
    voucherLog: opened.log,
    signer: deps.signer ?? defaultSigner,
    depositPort: deps.depositPort ?? defaultDepositPort,
    network: env.STELLAR_NETWORK,
    pricePerMibRaw: env.PRICE_PER_MIB_RAW,
    maxDeltaPerRequestRaw: env.MAX_DELTA_PER_REQUEST_RAW,
    portCallTimeoutMs: env.PORT_CALL_TIMEOUT_MS,
    ...(deps.emit !== undefined ? { emit: deps.emit } : {}),
  });

  return { status: "ready", instance: service };
}

/**
 * Composes env parsing + `buildAgentVouchersInstance` + the fail-closed
 * re-arm wrapper into the `FailClosedBoot<VoucherService>` that
 * `agent/app.ts` and `requireReady` share — the same shape as
 * `createServerBoot`, so both processes fail closed the same way (FC-R1..
 * FC-R8) even though only the server's boot touches the Stellar SDK today.
 */
export function createAgentBoot(options?: {
  rawEnv?: Record<string, string | undefined>;
  retryIntervalMs?: number;
  buildVouchersInstance?: (env: AgentEnv) => Promise<BuildResult<VoucherService>>;
  now?: () => number;
}): FailClosedBoot<VoucherService> {
  const rawEnv = options?.rawEnv ?? process.env;
  const buildVouchersInstance = options?.buildVouchersInstance ?? buildAgentVouchersInstance;

  return createFailClosedBoot<VoucherService>({
    retryIntervalMs: options?.retryIntervalMs ?? DEFAULT_INIT_RETRY_INTERVAL_MS,
    ...(options?.now !== undefined ? { now: options.now } : {}),
    buildInstance: async () => {
      const parsed = parseAgentEnv(rawEnv);
      if (!parsed.ok) {
        return { status: "unavailable", reason: "config_invalid", detail: parsed.detail };
      }
      return buildVouchersInstance(parsed.value);
    },
  });
}
