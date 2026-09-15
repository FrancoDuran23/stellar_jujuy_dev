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

import { Keypair, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { Mppx, Store, stellar } from "@stellar/mpp/charge/server";
import { fromBaseUnits } from "@stellar/mpp";
import { Receipt } from "mppx";
import type { ChargeOutcome, ChargePort } from "../server/charge-service.ts";
import { parseServerEnv, type ServerEnv } from "./env.ts";
import { isReason, type Reason } from "../shared/reasons.ts";

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
