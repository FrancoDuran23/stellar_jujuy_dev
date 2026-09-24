// Telnyx Wireless v2 provider (connectivity layer). Implements
// `ConnectivityProvider` against https://api.telnyx.com/v2 with axios.
// Docs: docs/telnyx-wireless-integracion.md
//
// Design notes:
// - Auth is account-wide: ONE `TELNYX_API_KEY` for all SIMs; the SIM is
//   identified by its `simCardId` (UUID), returned at purchase.
// - enable/disable are ASYNC (`202` + a SIM Card Action): `waitForAction`
//   polls `GET /sim_card_actions/{id}` every 2s (timeout 60s) so callers see
//   a synchronous result. A failed/interrupted action throws an
//   `TelnyxActionError` with the carrier's own `reason`.
// - `getUsage` returns MB exactly as the API reports them — NO conversion to
//   bytes here. That conversion is explicit in `src/jobs/reconciliation.ts`.
// - The HTTP client is injectable so unit tests pass a fake (never axios).
//
// Field names marked `// TODO: confirmar contra la API real` are the ones a
// live API key must validate before the MVP (see the summary at the end of the
// integration doc).

import axios from "axios";
import type { ConnectivityProvider, EsimRecord, SimUsage } from "./ConnectivityProvider.ts";

export const TELNYX_API_BASE = "https://api.telnyx.com/v2";

export const ACTION_POLL_INTERVAL_MS = 2_000;
export const ACTION_TIMEOUT_MS = 60_000;

/** Minimal axios-shaped HTTP seam. Both a real axios instance and a test fake
 * satisfy it. */
export type HttpClient = {
  get<T>(url: string, config?: { signal?: AbortSignal }): Promise<{ data: T }>;
  post<T>(url: string, body?: unknown, config?: { signal?: AbortSignal }): Promise<{ data: T }>;
  patch<T>(url: string, body?: unknown, config?: { signal?: AbortSignal }): Promise<{ data: T }>;
};

type TelnyxSimpleSimCard = {
  id?: string;
  iccid?: string;
  status?: { value?: string; reason?: string | null };
};

type TelnyxSimCardAction = {
  id?: string;
  action_type?: string;
  status?: { value?: string; reason?: string | null };
};

type TelnyxSimCard = TelnyxSimpleSimCard & {
  data_limit?: { amount?: string; unit?: string };
  current_billing_period_consumed_data?: { amount?: string; unit?: string };
};

type TelnyxActivationCode = {
  activation_code?: string;
  record_type?: string;
};

/** Thrown when a SIM card action ends in `failed`/`interrupted`. */
export class TelnyxActionError extends Error {
  readonly actionId: string;
  readonly statusValue: string;
  readonly reason: string | null;

  constructor(actionId: string, statusValue: string, reason: string | null) {
    super(`Telnyx SIM card action ${actionId} ended with status "${statusValue}"` +
      (reason ? ` (${reason})` : ""));
    this.name = "TelnyxActionError";
    this.actionId = actionId;
    this.statusValue = statusValue;
    this.reason = reason;
  }
}

/** Thrown when `waitForAction` never reaches a terminal state in time. */
export class TelnyxActionTimeoutError extends Error {
  readonly actionId: string;
  readonly timeoutMs: number;

  constructor(actionId: string, timeoutMs: number) {
    super(`Telnyx SIM card action ${actionId} did not complete within ${timeoutMs}ms`);
    this.name = "TelnyxActionTimeoutError";
    this.actionId = actionId;
    this.timeoutMs = timeoutMs;
  }
}

export type TelnyxProviderOptions = {
  apiKey: string;
  simGroupId: string;
  httpClient?: HttpClient;
  pollIntervalMs?: number;
  actionTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function defaultHttpClient(apiKey: string): HttpClient {
  return axios.create({
    baseURL: TELNYX_API_BASE,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
}

/** Builds the provider from env vars, failing fast with actionable messages
 * before any real call can be attempted. */
export function createTelnyxProvider(env: NodeJS.ProcessEnv = process.env): TelnyxProvider {
  const apiKey = env.TELNYX_API_KEY;
  const simGroupId = env.TELNYX_SIM_GROUP_ID;
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "Falta TELNYX_API_KEY — generala en portal.telnyx.com y agregala al .env antes de correr esto contra la API real.",
    );
  }
  if (simGroupId === undefined || simGroupId === "") {
    throw new Error(
      "Falta TELNYX_SIM_GROUP_ID — es el id (UUID) del SIM Card Group de la cuenta. " +
      "Crealo en portal.telnyx.com o por POST /sim_card_groups, y agregalo al .env.",
    );
  }
  return new TelnyxProvider({ apiKey, simGroupId });
}

export class TelnyxProvider implements ConnectivityProvider {
  private readonly http: HttpClient;
  private readonly simGroupId: string;
  private readonly pollIntervalMs: number;
  private readonly actionTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: TelnyxProviderOptions) {
    this.http = options.httpClient ?? defaultHttpClient(options.apiKey);
    this.simGroupId = options.simGroupId;
    this.pollIntervalMs = options.pollIntervalMs ?? ACTION_POLL_INTERVAL_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /** Purchases ONE eSIM for the session and returns its activation code.
   * The SIM is associated with `simGroupId` (its safety data limit) and tagged
   * with the userId for auditing. */
  async purchaseEsim(userId: string): Promise<EsimRecord> {
    const response = await this.http.post<{ data: TelnyxSimpleSimCard[] }>(
      "/actions/purchase/esims",
      {
        amount: 1,
        sim_card_group_id: this.simGroupId,
        status: "enabled",
        tags: [userId],
      },
    );
    const sim = response.data.data?.[0];
    // TODO: confirmar contra la API real los nombres exactos de `id`/`iccid`
    // en la respuesta de purchase (SimpleSIMCard según el OpenAPI oficial).
    if (sim === undefined || typeof sim.id !== "string" || sim.id === "") {
      throw new Error(`Telnyx purchaseEsim: la respuesta no trajo una SIM válida (id ausente).`);
    }
    const activationCode = await this.fetchActivationCode(sim.id);
    return {
      simCardId: sim.id,
      iccid: sim.iccid ?? "",
      activationCode,
    };
  }

  /** The activation code (LPA QR content) is served by its own endpoint and is
   * one-time — only available while the profile is not installed yet. */
  private async fetchActivationCode(simCardId: string): Promise<string> {
    const response = await this.http.get<{ data: TelnyxActivationCode }>(
      `/sim_cards/${simCardId}/activation_code`,
    );
    const code = response.data.data?.activation_code;
    if (typeof code !== "string" || code === "") {
      // TODO: confirmar contra la API real el nombre del campo de activación
      // (`activation_code` según el OpenAPI oficial).
      throw new Error(
        `Telnyx fetchActivationCode: la SIM ${simCardId} no devolvió activation_code.`,
      );
    }
    return code;
  }

  /** Enables the SIM. Resolves only when the async SIM Card Action completes. */
  async enable(simCardId: string): Promise<void> {
    const actionId = await this.startAction(simCardId, "/actions/enable");
    await this.waitForAction(actionId);
  }

  /** Disables the SIM (data cutoff). Resolves only when the action completes. */
  async disable(simCardId: string): Promise<void> {
    const actionId = await this.startAction(simCardId, "/actions/disable");
    await this.waitForAction(actionId);
  }

  /** Caps the SIM's remaining data to `mb` in the `MB` unit. Not async: Telnyx
   * applies `data_limit` immediately (PATCH). */
  async setDataLimit(simCardId: string, mb: number): Promise<void> {
    if (!Number.isFinite(mb) || mb < 0) {
      throw new RangeError(`setDataLimit: mb debe ser un número no negativo, recibí ${mb}`);
    }
    // TODO: confirmar contra la API real el campo `data_limit` de PATCH
    // /sim_cards/{id} (SIMCardUpdate según el OpenAPI oficial).
    await this.http.patch<{ data: TelnyxSimCard }>(`/sim_cards/${simCardId}`, {
      data_limit: { amount: String(mb), unit: "MB" },
    });
  }

  /** Reads reported consumption. `mb` comes back in MB EXACTLY as Telnyx
   * reports it — no conversion here, on purpose. */
  async getUsage(simCardId: string): Promise<SimUsage> {
    const response = await this.http.get<{ data: TelnyxSimCard }>(`/sim_cards/${simCardId}`);
    const sim = response.data.data;
    const consumed = sim?.current_billing_period_consumed_data;
    const mb = consumed?.amount !== undefined ? Number(consumed.amount) : 0;
    return {
      mb,
      status: sim?.status?.value ?? "unknown",
    };
  }

  /** Starts an async SIM card action and returns its `id`. */
  private async startAction(simCardId: string, actionPath: string): Promise<string> {
    const response = await this.http.post<{ data: TelnyxSimCardAction }>(
      `/sim_cards/${simCardId}${actionPath}`,
    );
    const actionId = response.data.data?.id;
    if (typeof actionId !== "string" || actionId === "") {
      throw new Error(`Telnyx startAction: ${actionPath} para la SIM ${simCardId} no devolvió id de acción.`);
    }
    return actionId;
  }

  /** Polls `GET /sim_card_actions/{id}` every `pollIntervalMs` until the action
   * is terminal (`completed`), throws on `failed`/`interrupted`, and gives up
   * after `actionTimeoutMs`. */
  private async waitForAction(actionId: string): Promise<void> {
    const deadline = this.now() + this.actionTimeoutMs;
    let lastValue: string | undefined;
    for (;;) {
      const response = await this.http.get<{ data: TelnyxSimCardAction }>(
        `/sim_card_actions/${actionId}`,
      );
      const status = response.data.data?.status;
      const value = status?.value;
      if (value === "completed") {
        return;
      }
      lastValue = value;
      if (value === "failed" || value === "interrupted") {
        throw new TelnyxActionError(actionId, value, status?.reason ?? null);
      }
      if (this.now() >= deadline) {
        throw new TelnyxActionTimeoutError(actionId, this.actionTimeoutMs);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }
}