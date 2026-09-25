// PolicyEnforcer (connectivity layer, docs/citrus-mobile-spec.md v2 §7 R8):
// the channel-budget decision. It turns "cumulative accounting bytes × price
// per MB" into a concrete provider action.
//
// The WEBHOOK is the real data cutoff in this architecture (D5): Citrus cuts
// data itself when the eSIM wallet hits 0, and the cap policy (unpaid cap,
// usage-loop) suspends/resumes around it. R8 *simplified* this loop to what the
// channel budget can still enforce:
// - remaining > 0 and ≥ 1 MB payable: NOOP — keep serving;
// - remaining ≈ 0 (cost covers the deposit, or not even 1 MB remains payable):
//   SUSPEND the eSIM — data cutoff.
//
// The decision is pure (`decidePolicy`) and separated from the side effects
// (`runOnce` applies it through the ConnectivityProvider), so tests verify the
// math without touching a network.
//
// Balance semantics (unchanged since the original enforcer): `getChannelBalance`
// returns the channel's CUMULATIVE DEPOSIT in raw units (1e-7 USDC) — NOT a
// remaining balance. The real adapter is `createStellarChannelBalanceAdapter`
// (`src/meter/meter-service.ts`). `costRaw` is computed from the trip's
// EQUIVALENT accounting bytes (spec §6.2 — the bytes the agent bills, which
// derive from the provider's charged micro-USD); `remaining = deposit − cost`,
// the same basis the agent uses for M2 `remaining` (deposit − highest signed
// amount). On-chain `balance()` must NOT be used here (it drops on every
// server `settle()`; subtracting cumulative cost from it would double-count).
//
// Dropped in the rework (R8): the low-balance watermark and `set_data_limit`
// (data limits are delegated to the eSIM wallet, the cap is the prepaid amount
// itself), and `disable` (now `suspend` — the eSIM must stay provisioned to
// keep its ethernet/identity; see EsimRecordStatus "cut"/"suspended").

import { ceilDiv, parseNonNegativeIntegerRaw } from "../shared/money.ts";
import { equivalentBytes } from "../shared/usage-math.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";

/** Carrier billing uses decimal MB: 1 MB = 1 000 000 bytes (NOT MiB). */
export const BYTES_PER_MB = 1_000_000n;

/** Suggested cadence for the enforcement loop (the task's "setInterval 5s"). */
export const ENFORCER_INTERVAL_MS_DEFAULT = 5_000;

/** Port into the Stellar channel component: returns the channel's cumulative
 * deposit in raw units (see "Balance semantics" above). Stub by default. */
export type ChannelBalancePort = {
  getChannelBalance(channelId: string): Promise<bigint>;
};

export const STUB_CHANNEL_BALANCE_PORT: ChannelBalancePort = {
  async getChannelBalance(_channelId: string): Promise<bigint> {
    throw new Error(
      "getChannelBalance STUB: conectar contra el componente Stellar (canal " +
      "one-way de la sesión) antes del MVP — se espera el depósito acumulado " +
      "en raw units (ver createStellarChannelBalanceAdapter).",
    );
  },
};

export type Logger = (line: unknown) => void;

/** Cost of the billed accounting bytes, in raw USDC units, at `pricePerMbRaw`
 * raw units per MB. Ceiling division keeps a full session's rounding bounded. */
export function computeCostRaw(meteredBytes: bigint, pricePerMbRaw: bigint): bigint {
  if (pricePerMbRaw <= 0n) {
    throw new RangeError("computeCostRaw: pricePerMbRaw debe ser positivo");
  }
  return ceilDiv(meteredBytes * pricePerMbRaw, BYTES_PER_MB);
}

export type DecideInput = {
  /** Channel cumulative deposit (`getChannelBalance`), raw units — never the
   * remaining balance: `remaining` is derived here as deposit − cost. */
  balanceRaw: bigint;
  /** Cost accrued so far from the accounting bytes, raw units. */
  costRaw: bigint;
  /** Price per MB, raw units (PRICE_PER_MB_RAW). */
  pricePerMbRaw: bigint;
};

export type EnforcementAction =
  | { kind: "suspend"; remainingRaw: bigint; reason: string }
  | { kind: "noop"; remainingRaw: bigint };

export function decidePolicy(input: DecideInput): EnforcementAction {
  if (input.pricePerMbRaw <= 0n) {
    throw new RangeError("decidePolicy: pricePerMbRaw debe ser positivo");
  }
  const remainingRaw = input.balanceRaw - input.costRaw < 0n ? 0n : input.balanceRaw - input.costRaw;

  // Remaining ≈ 0: the balance cannot cover the accrued cost at all.
  if (remainingRaw === 0n) {
    return { kind: "suspend", remainingRaw, reason: "saldo del canal agotado (remaining == 0)" };
  }

  // The price is known positive (enforced upstream); the whole MB this balance
  // can still pay. If even 1 MB is unpayable, there is nothing left to serve.
  const payableMb = remainingRaw / input.pricePerMbRaw;
  if (payableMb <= 0n) {
    return {
      kind: "suspend",
      remainingRaw,
      reason: "el saldo restante no alcanza ni para 1 MB",
    };
  }

  return { kind: "noop", remainingRaw };
}

export type PolicyEnforcerOptions = {
  provider: ConnectivityProvider;
  channelBalancePort?: ChannelBalancePort;
  /** Raw USDC units per MB — normally from PRICE_PER_MB_RAW. */
  pricePerMbRaw?: bigint;
  /** Markup applied by the usage loop to turn charged micro-USD into the
   * accounting bytes the enforcer bills against (spec §6.2). */
  markupBps?: number;
  /** USDC/USD rate, basis points (same unit as usage-loop). */
  usdcUsdRateBps?: number;
  logger?: Logger;
};

export function createPolicyEnforcer(
  options: PolicyEnforcerOptions,
  env: NodeJS.ProcessEnv = process.env,
): PolicyEnforcer {
  const pricePerMbRaw = options.pricePerMbRaw ?? readPriceRaw(env);
  return new PolicyEnforcer({ ...options, pricePerMbRaw });
}

function readPriceRaw(env: NodeJS.ProcessEnv): bigint {
  const raw = env.PRICE_PER_MB_RAW;
  if (raw === undefined || raw === "") {
    throw new Error(
      "Falta PRICE_PER_MB_RAW — precio por MB en USDC raw units (1e-7 USDC). " +
      "Definilo en el .env para que el enforcer pueda decidir cortes.",
    );
  }
  const parsed = parseNonNegativeIntegerRaw(raw);
  if (parsed === undefined) {
    throw new Error(
      `PRICE_PER_MB_RAW debe ser un entero no negativo (raw units), recibí "${raw}"`,
    );
  }
  return parsed;
}

export class PolicyEnforcer {
  private readonly provider: ConnectivityProvider;
  private readonly channelBalancePort: ChannelBalancePort;
  private readonly pricePerMbRaw: bigint;
  private readonly markupBps: number;
  private readonly usdcUsdRateBps: number;
  private readonly logger: Logger;

  constructor(options: PolicyEnforcerOptions & { pricePerMbRaw: bigint }) {
    this.provider = options.provider;
    this.channelBalancePort = options.channelBalancePort ?? STUB_CHANNEL_BALANCE_PORT;
    this.pricePerMbRaw = options.pricePerMbRaw;
    this.markupBps = options.markupBps ?? 15_000;
    this.usdcUsdRateBps = options.usdcUsdRateBps ?? 10_000;
    this.logger = options.logger ?? ((line) => console.log(JSON.stringify(line)));
  }

  /** Billed bytes := equivalent bytes of THIS trip's charged consumption (the
   * provider reports lifetime charged, so the trip is charged − baseline, R13).
   * Pure decision; never touches the provider beyond the balance port. */
  async decide(session: ConnectivitySession): Promise<EnforcementAction> {
    const tripChargedMicroUsd = session.chargedMicroUsd > session.chargedBaselineMicroUsd
      ? session.chargedMicroUsd - session.chargedBaselineMicroUsd
      : 0n;
    const eqBytes = equivalentBytes(
      tripChargedMicroUsd,
      this.markupBps,
      this.usdcUsdRateBps,
      this.pricePerMbRaw,
    );
    const balanceRaw = await this.channelBalancePort.getChannelBalance(session.channelId);
    const costRaw = computeCostRaw(eqBytes, this.pricePerMbRaw);
    return decidePolicy({ balanceRaw, costRaw, pricePerMbRaw: this.pricePerMbRaw });
  }

  /** Applies `decide`'s outcome through the provider. */
  async runOnce(session: ConnectivitySession): Promise<EnforcementAction> {
    const action = await this.decide(session);
    await this.apply(action, session);
    return action;
  }

  /** Wraps `runOnce` on a timer. Returns a stop function for cleanup. */
  start(session: ConnectivitySession, intervalMs: number = ENFORCER_INTERVAL_MS_DEFAULT): () => void {
    const timer = setInterval(() => {
      this.runOnce(session).then(
        (action) => {
          this.logger({
            level: "info",
            reason: "policy_enforcement",
            sessionId: session.id,
            action: action.kind,
            ...(action.kind === "suspend" ? { reason: action.reason } : {}),
            remainingRaw: action.remainingRaw.toString(),
          });
        },
        (error: unknown) => {
          this.logger({
            level: "error",
            reason: "policy_enforcement_failed",
            sessionId: session.id,
            detail: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }, intervalMs);
    return () => clearInterval(timer);
  }

  private async apply(action: EnforcementAction, session: ConnectivitySession): Promise<void> {
    switch (action.kind) {
      case "suspend":
        await this.provider.suspend(session.iccid);
        return;
      case "noop":
        return;
    }
  }
}