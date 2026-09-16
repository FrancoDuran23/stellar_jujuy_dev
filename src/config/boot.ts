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
  verifyCommitmentSignature,
  type ChannelContractDeps,
} from "../shared/stellar/channel-contract.ts";
import { close as closeChannelOnChain, getChannelState, watchChannel } from "@stellar/mpp/channel/server";
import { Horizon } from "@stellar/stellar-sdk";
import { getSep41BalanceRaw } from "../shared/stellar/channel-contract.ts";
import type { TrustlinePort } from "../shared/stellar/trustline.ts";
import {
  createChannelService,
  type ChannelChainInfo,
  type ChannelClosePort,
  type ChannelService,
  type ChannelStatePort,
  type ChannelVerifyPort,
  type UsdcBalancePort,
} from "../server/channel-service.ts";
import { createChannelVoucherStore } from "../server/channel-store.ts";
import { createCloseMonitor, type CloseMonitor, type CloseWatchPort } from "../server/close-monitor.ts";

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
 * Decorates any `SignerPort` so that, once signing succeeds, the same
 * commitment is ALSO delivered to the payment server's `POST /channel/
 * vouchers` (design 4.2's "A->>S: POST /channel/vouchers (voucher + MPP
 * credential)" step) before returning — so the caller
 * (`agent/routes/vouchers.ts`) appends to its own JSONL, and therefore
 * responds M2 to the gateway, only after the server has durably accepted
 * the voucher (matches the exact ordering design 4.2 specifies).
 *
 * Integration-shape decision (task brief, documented per its own
 * instruction to "state which path you took and why" — see docs/sdd/
 * payments-mpp.md §6, Lote E for the full writeup): this is a HAND-ROLLED
 * POST, not `@stellar/mpp/channel/client`'s `stellar.channel(...)` Method.
 * Two independent reasons ruled the SDK client flow out:
 *
 * 1. The SDK client's `createCredential` only reports lifecycle events
 *    (`challenge`/`signing`/`signed{cumulativeAmount}`) — it never exposes
 *    the raw signature/commitmentPubkey hex to the caller. M2 (the agent's
 *    OWN response contract to the gateway, frozen and external) needs
 *    exactly those two fields verbatim, so driving the SDK client would
 *    still require an independent hand-rolled signature afterward anyway —
 *    pure duplicated RPC/signing work for zero benefit, since ed25519 is
 *    deterministic and both signatures would be byte-identical.
 * 2. The SDK server's `verify()` (the other half of that Method) is only
 *    reachable through its own challenge/credential round trip mediated by
 *    an `Mppx` server instance — there is no supported way to call it for a
 *    voucher whose signature was already computed independently. Driving
 *    the full client flow just to reach that `verify()` would mean
 *    re-implementing our own internal agent -> server hop as a second,
 *    redundant HTTP 402 dance for a link both ends already fully control
 *    and trust (the ed25519 signature itself is the credential — see
 *    `server/routes/channel.ts`'s doc comment).
 *
 * The commitment IS produced with the SDK-equivalent recipe
 * (`createRealChannelSigner`: simulate + bind-check + sign, spike Part A),
 * and the server verifies it with that exact same recipe
 * (`createServerChannelVerifyPort`) — only the wire transport between the
 * two is hand-rolled instead of mppx's Method/Credential envelope.
 */
export function createServerDeliveringSigner(
  innerSigner: SignerPort,
  options: { paymentServerUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): SignerPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  return {
    async sign(input) {
      const result = await innerSigner.sign(input);
      const url = new URL("/channel/vouchers", options.paymentServerUrl).toString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: input.channel,
            network: input.network,
            cumulativeAmount: input.cumulativeAmount,
            signature: result.signature,
            commitmentPubkey: result.commitmentPubkey,
            sessionId: input.sessionId,
            cumulativeBytes: input.cumulativeBytes,
            meterReadingId: input.meterReadingId,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(`payment server returned a non-JSON response (HTTP ${response.status}): ${messageOf(error)}`);
      }
      if (!response.ok) {
        throw new Error(`payment server rejected the voucher delivery (HTTP ${response.status}): ${JSON.stringify(body)}`);
      }
      const accepted = (body as { accepted?: unknown }).accepted;
      if (accepted !== true) {
        const reason = (body as { reason?: unknown }).reason;
        const detail = (body as { detail?: unknown }).detail;
        throw new Error(`payment server rejected the voucher: ${String(reason)} — ${String(detail)}`);
      }
      return result;
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

// ---------------------------------------------------------------------------
// Stage 2, server side (WU7): channel verification + close ports, all built
// with the real SDK here and nowhere else (design 4.1's testability rule).
// ---------------------------------------------------------------------------

/** Real `ChannelStatePort` (`server/channel-service.ts`, `server/
 * close-monitor.ts`): the richer sibling of `createStellarChannelRpcPort`
 * above (adds `balanceRaw`/`currentLedger`, needed for the close-monitor's
 * backup invariant and the close flow's refund math). Never throws — an RPC
 * failure reports `{found: false}` (spike's XDR-crash finding: every
 * request-serving RPC call must degrade, never crash). */
export function createServerChannelStatePort(env: {
  SOROBAN_RPC_URL: string;
  STELLAR_NETWORK: ChannelContractDeps["network"];
  DATA_DIR: string;
}): ChannelStatePort {
  const channelDeps: ChannelContractDeps = { rpcUrl: env.SOROBAN_RPC_URL, network: env.STELLAR_NETWORK };
  return {
    async getChannelInfo(channel): Promise<ChannelChainInfo> {
      try {
        const state = await getChannelState({ channel, network: env.STELLAR_NETWORK, rpcUrl: env.SOROBAN_RPC_URL });
        let depositRaw = await tryGetDepositedRaw(channelDeps, channel);
        if (depositRaw === undefined) {
          const record = readChannelRecord(channelRecordPath(env.DATA_DIR, env.STELLAR_NETWORK));
          depositRaw = record !== undefined && record.channel === channel ? BigInt(record.depositRaw) : state.balance;
        }
        return {
          found: true,
          depositRaw,
          balanceRaw: state.balance,
          closeEffectiveAtLedger: state.closeEffectiveAtLedger,
          currentLedger: state.currentLedger,
        };
      } catch {
        return { found: false };
      }
    },
  };
}

/** Real `ChannelVerifyPort`: the exact recipe `@stellar/mpp`'s server
 * verifies with internally (simulate `prepare_commitment`, verify locally
 * against `COMMITMENT_PUBKEY` — spike Part A), hand-implemented here since
 * the SDK's own verification is only reachable through its Method/Credential
 * wire protocol (see `server/channel-store.ts`'s deviation note). */
export function createServerChannelVerifyPort(
  env: { SOROBAN_RPC_URL: string; STELLAR_NETWORK: ChannelContractDeps["network"] },
  commitmentPubkeyHex: string,
): ChannelVerifyPort {
  const channelDeps: ChannelContractDeps = { rpcUrl: env.SOROBAN_RPC_URL, network: env.STELLAR_NETWORK };
  return {
    async verifyCommitment({ channel, amountRaw, signatureHex }) {
      const bytes = await prepareCommitmentBytes(channelDeps, channel, amountRaw);
      try {
        assertCommitmentBinds(bytes, { channel, amount: amountRaw, network: env.STELLAR_NETWORK });
      } catch {
        return false;
      }
      return verifyCommitmentSignature(commitmentPubkeyHex, bytes, signatureHex);
    },
  };
}

/** Real `ChannelClosePort`: wraps `@stellar/mpp/channel/server`'s standalone
 * `close()` export — the ONLY function in this codebase that submits a
 * `close` transaction (task requirement enforced structurally: nothing else
 * imports `closeChannelOnChain`). */
export function createServerChannelClosePort(env: {
  SOROBAN_RPC_URL: string;
  STELLAR_NETWORK: ChannelContractDeps["network"];
  FEE_PAYER_SECRET: string;
}): ChannelClosePort {
  const envelopeSigner = Keypair.fromSecret(env.FEE_PAYER_SECRET);
  return {
    async close({ channel, amountRaw, signatureHex }) {
      const txHash = await closeChannelOnChain({
        channel,
        amount: amountRaw,
        signature: Buffer.from(signatureHex, "hex"),
        feePayer: { envelopeSigner },
        network: env.STELLAR_NETWORK,
        rpcUrl: env.SOROBAN_RPC_URL,
      });
      return { txHash };
    },
  };
}

/** Real `UsdcBalancePort`: SEP-41 `balance(address)` on `USDC_SAC_CONTRACT`
 * (CL-R10's pre/post balance-delta assertion). */
export function createUsdcBalancePort(env: {
  SOROBAN_RPC_URL: string;
  STELLAR_NETWORK: ChannelContractDeps["network"];
  USDC_SAC_CONTRACT: string;
}): UsdcBalancePort {
  const channelDeps: ChannelContractDeps = { rpcUrl: env.SOROBAN_RPC_URL, network: env.STELLAR_NETWORK };
  return {
    getUsdcBalanceRaw: (accountId) => getSep41BalanceRaw(channelDeps, env.USDC_SAC_CONTRACT, accountId),
  };
}

/** Real Horizon-backed `TrustlinePort` (CL-R9) — same recipe
 * `scripts/preflight.ts` already uses. Tri-state (review finding 3, Lote F):
 * a Horizon error (down, timeout, rate-limited, ...) reports `"unknown"`,
 * never `"no"` — callers fail OPEN on a diagnosis failure instead of
 * blocking a close exactly when a dispute needs it most. `usdcIssuer`, when
 * given, also checks the trustline's issuer (`USDC_ISSUER`, optional —
 * `config/env.ts`'s own doc comment on that field explains why it has no
 * default); without it the check degrades to `asset_code === "USDC"` alone,
 * same as before this fix. */
export function createHorizonTrustlinePort(horizonUrl: string, usdcIssuer?: string): TrustlinePort {
  const horizon = new Horizon.Server(horizonUrl);
  return {
    async hasUsdcTrustline(accountId) {
      try {
        const account = await horizon.loadAccount(accountId);
        const hasIt = account.balances.some((balance) => {
          if (!("asset_code" in balance) || balance.asset_code !== "USDC") return false;
          if (usdcIssuer === undefined) return true;
          return "asset_issuer" in balance && balance.asset_issuer === usdcIssuer;
        });
        return hasIt ? "yes" : "no";
      } catch {
        return "unknown";
      }
    },
  };
}

const HORIZON_URLS: Record<ChannelContractDeps["network"], string> = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
  "stellar:pubnet": "https://horizon.stellar.org",
};

/** Real `CloseWatchPort`: wraps `@stellar/mpp/channel/server`'s
 * `watchChannel()`. Any `close`-topic event (pending or already-effective —
 * spike's own note that the topic alone cannot tell them apart) is treated
 * as the dispute signal; `onError` here matches the spike's own finding
 * (an unrelated ledger's XDR can crash a long-lived polling loop on this
 * SDK version) — recorded, never rethrown. */
export function createWatchChannelPort(
  channel: string,
  env: { SOROBAN_RPC_URL: string; STELLAR_NETWORK: ChannelContractDeps["network"] },
): CloseWatchPort {
  return {
    watch(onEvent, onError) {
      try {
        return watchChannel({
          channel,
          network: env.STELLAR_NETWORK,
          rpcUrl: env.SOROBAN_RPC_URL,
          onEvent: (event) => {
            if (event.type === "close") onEvent();
          },
          onError,
        });
      } catch (error) {
        onError(error);
        return () => {};
      }
    },
  };
}

export type ServerChannelInstance = {
  channelService: ChannelService;
  closeMonitor: CloseMonitor;
};

/**
 * Composes the server's stage-2 channel instance (WU7): the accepted-
 * commitment store (rebuilt from `data/vouchers-server-{network}.jsonl` at
 * open time), the four real ports, `createChannelService`, and
 * `createCloseMonitor` wired to call `channelService.closeChannel` on any
 * detected dispute. Returns `unavailable` only for a voucher-log open
 * failure (FC-R3) — every RPC-touching port degrades to a typed result
 * instead of throwing, so this never needs its own health check the way
 * `buildServerChargeInstance` does.
 */
export async function buildServerChannelInstance(
  env: ServerEnv & { CHANNEL_CONTRACT: string; COMMITMENT_PUBKEY: string; FUNDER_ACCOUNT: string },
  deps: { voucherLogPath?: string; emit?: (input: EmitInput) => void } = {},
): Promise<BuildResult<ServerChannelInstance>> {
  const voucherLogPath =
    deps.voucherLogPath ?? path.join(env.DATA_DIR, `vouchers-server-${env.STELLAR_NETWORK}.jsonl`);
  let opened: ReturnType<typeof VoucherLog.open>;
  try {
    opened = VoucherLog.open(voucherLogPath);
  } catch (error) {
    return { status: "unavailable", reason: "voucher_log_corrupt", detail: messageOf(error) };
  }
  if (opened.status === "corrupt") {
    return { status: "unavailable", reason: opened.reason, detail: opened.detail };
  }

  const channel = env.CHANNEL_CONTRACT;
  try {
    const store = createChannelVoucherStore(opened.log);
    const statePort = createServerChannelStatePort(env);
    const verifyPort = createServerChannelVerifyPort(env, env.COMMITMENT_PUBKEY);
    const closePort = createServerChannelClosePort(env);
    const trustlinePort = createHorizonTrustlinePort(HORIZON_URLS[env.STELLAR_NETWORK], env.USDC_ISSUER);
    const usdcBalancePort = createUsdcBalancePort(env);

    const channelService = createChannelService({
      store,
      verifyPort,
      statePort,
      closePort,
      trustlinePort,
      usdcBalancePort,
      funderAccount: env.FUNDER_ACCOUNT,
      recipientAccount: env.STELLAR_RECIPIENT,
      closeAssertAttempts: env.CLOSE_ASSERT_ATTEMPTS,
      closeAssertIntervalMs: env.CLOSE_ASSERT_INTERVAL_MS,
      ...(deps.emit !== undefined ? { emit: deps.emit } : {}),
    });

    const closeMonitor = createCloseMonitor({
      channel,
      statePort,
      watchPort: createWatchChannelPort(channel, env),
      pollIntervalMs: env.CHANNEL_POLL_INTERVAL_MS,
      // Review finding 1 (Lote F): `channelService.closeChannel` never
      // rejects any more (every failure mode resolves to a typed
      // `CloseOutcome`), but this wiring still never trusts that alone — a
      // throw here is caught and WARNed instead of becoming an unhandled
      // rejection that would kill the process exactly when a dispute was
      // detected. `close-monitor.ts` only latches its own `triggered` state
      // on `{closed:true}` (review finding 3).
      onClosingDetected: async () => {
        try {
          const outcome = await channelService.closeChannel(channel);
          return { closed: outcome.kind === "closed" };
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              reason: "close_channel_attempt_failed",
              channel,
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
          return { closed: false };
        }
      },
      ...(deps.emit !== undefined ? { emit: deps.emit } : {}),
    });

    return { status: "ready", instance: { channelService, closeMonitor } };
  } catch (error) {
    return { status: "unavailable", reason: "config_invalid", detail: messageOf(error) };
  }
}

/**
 * Composes env parsing + `buildServerChannelInstance` + the fail-closed
 * re-arm wrapper (same shape as `createServerBoot`/`createAgentBoot`).
 * `server/main.ts` only calls `ensureReady()` — and only starts listening on
 * `/channel/vouchers` / the close-monitor — once `env.CHANNEL_CONTRACT` is
 * present (stage 2); a stage-1-only deployment never builds this at all.
 */
export function createServerChannelBoot(options?: {
  rawEnv?: Record<string, string | undefined>;
  retryIntervalMs?: number;
  buildChannelInstance?: (
    env: ServerEnv & { CHANNEL_CONTRACT: string; COMMITMENT_PUBKEY: string; FUNDER_ACCOUNT: string },
  ) => Promise<BuildResult<ServerChannelInstance>>;
  now?: () => number;
}): FailClosedBoot<ServerChannelInstance> {
  const rawEnv = options?.rawEnv ?? process.env;
  const buildChannelInstance = options?.buildChannelInstance ?? buildServerChannelInstance;

  return createFailClosedBoot<ServerChannelInstance>({
    retryIntervalMs: options?.retryIntervalMs ?? DEFAULT_INIT_RETRY_INTERVAL_MS,
    ...(options?.now !== undefined ? { now: options.now } : {}),
    buildInstance: async () => {
      const parsed = parseServerEnv(rawEnv);
      if (!parsed.ok) {
        return { status: "unavailable", reason: "config_invalid", detail: parsed.detail };
      }
      if (
        parsed.value.CHANNEL_CONTRACT === undefined ||
        parsed.value.COMMITMENT_PUBKEY === undefined ||
        parsed.value.FUNDER_ACCOUNT === undefined
      ) {
        return {
          status: "unavailable",
          reason: "config_invalid",
          detail: "stage 2 is not configured (CHANNEL_CONTRACT/COMMITMENT_PUBKEY/FUNDER_ACCOUNT unset)",
        };
      }
      return buildChannelInstance({
        ...parsed.value,
        CHANNEL_CONTRACT: parsed.value.CHANNEL_CONTRACT,
        COMMITMENT_PUBKEY: parsed.value.COMMITMENT_PUBKEY,
        FUNDER_ACCOUNT: parsed.value.FUNDER_ACCOUNT,
      });
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
    ? createServerDeliveringSigner(createRealChannelSigner(env.COMMITMENT_SECRET!, channelDeps), {
        paymentServerUrl: env.PAYMENT_SERVER_URL,
      })
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
