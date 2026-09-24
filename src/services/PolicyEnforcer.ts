// PolicyEnforcer (connectivity layer): the decision loop that turns "bytes
// measured by the gateway × price per MB" into concrete Telnyx actions.
//
// It is designed to run on a timer (every 5s) and, from the channel budget:
// - while the remaining balance is above the low watermark (20% of deposit):
//   NOOP — keep serving;
// - once remaining ≤ 20% of the deposit: tighten the SIM's `data_limit` to
//   the MB the remaining balance can still pay;
// - once remaining ≈ 0 (or the remaining balance cannot pay even 1 MB):
//   DISABLE the SIM — data cutoff.
//
// The decision is pure (`decidePolicy`) and separated from the side effects
// (`runOnce` applies it through the ConnectivityProvider), so tests verify the
// math without touching a network.
//
// Balance semantics (resolved against the channel code): `getChannelBalance`
// returns the channel's CUMULATIVE DEPOSIT in raw units (1e-7 USDC) — NOT a
// remaining balance. The real adapter is `createStellarChannelBalanceAdapter`
// (`src/meter/meter-service.ts`), which reads `ChannelChainInfo.depositRaw`
// (`config/boot.ts`: the contract's `deposited()` getter, falling back to the
// local `channel:open`/`top-up` record, and last to on-chain `balance()` as a
// conservative lower bound). That is the right basis because `costRaw` is
// cumulative since channel open, so `remaining = deposit − cost` — the same
// basis the agent uses for M2 `remaining` (deposit − highest signed amount).
// On-chain `balance()` (`depositRaw`'s sibling `balanceRaw`) must NOT be used
// here: it drops on every server `settle()`, and subtracting the cumulative
// cost from it would double-count what was already collected. The 20%
// watermark below is therefore "20% of the deposit", as documented.
// `STUB_CHANNEL_BALANCE_PORT` remains the default only for callers that do
// not inject a port.

import { ceilDiv, parseNonNegativeIntegerRaw } from "../shared/money.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";

/** Carrier billing uses decimal MB: 1 MB = 1 000 000 bytes (NOT MiB). This is
 * also the unit the Telnyx MB figures are compared against in reconciliation. */
export const BYTES_PER_MB = 1_000_000n;

/** Default low-balance watermark: change the data limit once the remaining
 * balance drops to this fraction of the deposit (2000 bps = 20%). */
export const LOW_BALANCE_BPS_DEFAULT = 2000;

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

/** Cost of the consumed bytes, in raw USDC units, at `pricePerMbRaw` raw units
 * per MB. Ceiling division keeps a full session's rounding error bounded. */
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
  /** Cost accrued so far from gateway-measured bytes, raw units. */
  costRaw: bigint;
  /** Price per MB, raw units (same encoding as `TELNYX_PRICE_PER_MB_USDC`). */
  pricePerMbRaw: bigint;
};

export type EnforcementAction =
  | { kind: "set_data_limit"; mb: number; remainingRaw: bigint }
  | { kind: "disable"; remainingRaw: bigint; reason: string }
  | { kind: "noop"; remainingRaw: bigint };

export function decidePolicy(
  input: DecideInput,
  lowBalanceBps: number = LOW_BALANCE_BPS_DEFAULT,
): EnforcementAction {
  if (input.pricePerMbRaw <= 0n) {
    throw new RangeError("decidePolicy: pricePerMbRaw debe ser positivo");
  }
  const remainingRaw = input.balanceRaw - input.costRaw < 0n ? 0n : input.balanceRaw - input.costRaw;

  // Remaining ≈ 0: the balance cannot cover the accrued cost at all.
  if (remainingRaw === 0n) {
    return { kind: "disable", remainingRaw, reason: "saldo del canal agotado (remaining == 0)" };
  }

  // The price is known positive (enforced upstream); the whole MB this balance
  // can still pay. If even 1 MB is unpayable, there is nothing left to meter.
  const payableMb = remainingRaw / input.pricePerMbRaw;
  if (payableMb <= 0n) {
    return {
      kind: "disable",
      remainingRaw,
      reason: "el saldo restante no alcanza ni para 1 MB",
    };
  }

  // Low watermark: once ≤ `lowBalanceBps`/10000 of the deposited budget is
  // left, tighten the SIM's data limit to what remains payable.
  const lowWatermarkRaw = (input.balanceRaw * BigInt(lowBalanceBps)) / 10_000n;
  if (remainingRaw <= lowWatermarkRaw) {
    return { kind: "set_data_limit", mb: Number(payableMb), remainingRaw };
  }

  return { kind: "noop", remainingRaw };
}

export type PolicyEnforcerOptions = {
  provider: ConnectivityProvider;
  channelBalancePort?: ChannelBalancePort;
  /** Raw USDC units per MB — normally from TELNYX_PRICE_PER_MB_USDC. */
  pricePerMbRaw?: bigint;
  lowBalanceBps?: number;
  logger?: Logger;
};

export function createPolicyEnforcer(
  options: PolicyEnforcerOptions,
  env: NodeJS.ProcessEnv = process.env,
): PolicyEnforcer {
  const pricePerMbRaw =
    options.pricePerMbRaw ?? readPriceRaw(env);
  return new PolicyEnforcer({
    ...options,
    pricePerMbRaw,
  });
}

function readPriceRaw(env: NodeJS.ProcessEnv): bigint {
  const raw = env.TELNYX_PRICE_PER_MB_USDC;
  if (raw === undefined || raw === "") {
    throw new Error(
      "Falta TELNYX_PRICE_PER_MB_USDC — precio por MB en USDC raw units (1e-7 USDC). " +
      "Definilo en el .env para que el enforcer pueda decidir cortes.",
    );
  }
  const parsed = parseNonNegativeIntegerRaw(raw);
  if (parsed === undefined) {
    throw new Error(`TELNYX_PRICE_PER_MB_USDC debe ser un entero no negativo (raw units), recibí "${raw}"`);
  }
  return parsed;
}

export class PolicyEnforcer {
  private readonly provider: ConnectivityProvider;
  private readonly channelBalancePort: ChannelBalancePort;
  private readonly pricePerMbRaw: bigint;
  private readonly lowBalanceBps: number;
  private readonly logger: Logger;

  constructor(options: PolicyEnforcerOptions & { pricePerMbRaw: bigint }) {
    this.provider = options.provider;
    this.channelBalancePort = options.channelBalancePort ?? STUB_CHANNEL_BALANCE_PORT;
    this.pricePerMbRaw = options.pricePerMbRaw;
    this.lowBalanceBps = options.lowBalanceBps ?? LOW_BALANCE_BPS_DEFAULT;
    this.logger = options.logger ?? ((line) => console.log(JSON.stringify(line)));
  }

  /** Pure decision for a session's current state. Never touches Telnyx. */
  async decide(session: ConnectivitySession): Promise<EnforcementAction> {
    const balanceRaw = await this.channelBalancePort.getChannelBalance(session.channelId);
    const costRaw = computeCostRaw(session.meteredBytes, this.pricePerMbRaw);
    return decidePolicy({ balanceRaw, costRaw, pricePerMbRaw: this.pricePerMbRaw }, this.lowBalanceBps);
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
            ...(action.kind === "set_data_limit" ? { mb: action.mb } : {}),
            ...(action.kind === "disable" ? { reason: action.reason } : {}),
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
      case "set_data_limit":
        await this.provider.setDataLimit(session.simCardId, action.mb);
        return;
      case "disable":
        await this.provider.disable(session.simCardId);
        return;
      case "noop":
        return;
    }
  }
}