import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelnyxProvider,
  TelnyxActionError,
  TelnyxActionTimeoutError,
  createTelnyxProvider,
  type HttpClient,
} from "./TelnyxProvider.ts";

// The provider talks to a `HttpClient` seam, so tests use a recording fake —
// exactly the degree of mocking the task asks for, without baking in axios.
type RequestRecord = { method: string; url: string; body?: unknown };

class FakeHttp implements HttpClient {
  readonly calls: RequestRecord[] = [];

  private handlers: Array<{ urlPrefix: string; respond: () => unknown }> = [];
  private throwOnce: unknown | null = null;

  /** Registers a responder for URLs starting with `urlPrefix`. Later handlers
   * run in registration order; the `respond` closure may keep its own state to
   * simulate a poll that eventually completes. */
  on(urlPrefix: string, respond: () => unknown): this {
    this.handlers.push({ urlPrefix, respond });
    return this;
  }

  /** Makes the next dispatched call reject, then normal service resumes. */
  nextRejects(error: unknown): this {
    this.throwOnce = error;
    return this;
  }

  get<T>(url: string): Promise<{ data: T }> {
    return this.dispatch<T>("GET", url);
  }

  post<T>(url: string, body?: unknown): Promise<{ data: T }> {
    return this.dispatch<T>("POST", url, body);
  }

  patch<T>(url: string, body?: unknown): Promise<{ data: T }> {
    return this.dispatch<T>("PATCH", url, body);
  }

  private async dispatch<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ data: T }> {
    this.calls.push({ method, url, body });
    if (this.throwOnce !== null) {
      const error = this.throwOnce;
      this.throwOnce = null;
      throw error;
    }
    const handler = this.handlers.find((h) => url.startsWith(h.urlPrefix));
    if (handler === undefined) {
      throw new Error(`FakeHttp: no handler for ${method} ${url} (registrados: ${
        this.handlers.map((h) => h.urlPrefix).join(", ") || "ninguno"
      })`);
    }
    return { data: handler.respond() as T };
  }
}

function makeProvider(http: HttpClient, options?: { now?: () => number }): TelnyxProvider {
  return new TelnyxProvider({
    apiKey: "test-key",
    simGroupId: "group-1",
    httpClient: http,
    sleep: async () => {},
    now: options?.now,
  });
}

const ACTIVATION_DATA = { data: { activation_code: "LPA:1$smatm.com$test" } };

// --- purchaseEsim ---

test("purchaseEsim posts the SIM card group and returns id, iccid and activation code", async () => {
  const http = new FakeHttp()
    .on("/actions/purchase/esims", () => ({
      data: [{ id: "sim-1", iccid: "iccid-1", status: { value: "enabled" } }],
    }))
    .on("/sim_cards/sim-1/activation_code", () => ACTIVATION_DATA);

  const provider = makeProvider(http);
  const record = await provider.purchaseEsim("user-7");

  assert.equal(record.simCardId, "sim-1");
  assert.equal(record.iccid, "iccid-1");
  assert.equal(record.activationCode, "LPA:1$smatm.com$test");

  const purchase = http.calls.find((c) => c.method === "POST" && c.url === "/actions/purchase/esims");
  assert.ok(purchase, "se llamó al endpoint de purchase");
  assert.deepEqual(purchase!.body, {
    amount: 1,
    sim_card_group_id: "group-1",
    status: "enabled",
    tags: ["user-7"],
  });
});

test("purchaseEsim rejects when the response carries no SIM id", async () => {
  const http = new FakeHttp()
    .on("/actions/purchase/esims", () => ({ data: [] }));

  const provider = makeProvider(http);
  await assert.rejects(
    () => provider.purchaseEsim("user-7"),
    /no trajo una SIM válida/,
  );
});

test("purchaseEsim rejects when no activation code comes back", async () => {
  const http = new FakeHttp()
    .on("/actions/purchase/esims", () => ({
      data: [{ id: "sim-1", iccid: "iccid-1" }],
    }))
    .on("/sim_cards/sim-1/activation_code", () => ({ data: {} }));

  const provider = makeProvider(http);
  await assert.rejects(
    () => provider.purchaseEsim("user-7"),
    /no devolvió activation_code/,
  );
});

// --- enable / disable (async SIM card actions + polling) ---

test("enable polls the SIM card action until completed", async () => {
  const http = new FakeHttp();
  let polls = 0;
  http
    .on("/sim_cards/sim-1/actions/enable", () => ({
      data: { id: "act-1", status: { value: "in-progress" } },
    }))
    .on("/sim_card_actions/act-1", () => ({
      data: { id: "act-1", status: { value: polls++ === 0 ? "in-progress" : "completed" } },
    }));

  const provider = makeProvider(http);
  await provider.enable("sim-1");

  assert.ok(http.calls.some((c) => c.method === "POST" && c.url === "/sim_cards/sim-1/actions/enable"));
  assert.ok(
    http.calls.filter((c) => c.url === "/sim_card_actions/act-1").length >= 2,
    "se encuesta la acción hasta el estado terminal",
  );
});

test("disable resolves when the action completes", async () => {
  const http = new FakeHttp()
    .on("/sim_cards/sim-1/actions/disable", () => ({
      data: { id: "act-2", status: { value: "in-progress" } },
    }))
    .on("/sim_card_actions/act-2", () => ({
      data: { id: "act-2", status: { value: "completed" } },
    }));

  const provider = makeProvider(http);
  await provider.disable("sim-1");

  assert.ok(http.calls.some((c) => c.method === "POST" && c.url === "/sim_cards/sim-1/actions/disable"));
});

test("enable throws TelnyxActionError with the carrier reason when the action fails", async () => {
  const http = new FakeHttp()
    .on("/sim_cards/sim-1/actions/enable", () => ({
      data: { id: "act-1", status: { value: "in-progress" } },
    }))
    .on("/sim_card_actions/act-1", () => ({
      data: { id: "act-1", status: { value: "failed", reason: "carrier blocked the sim" } },
    }));

  const provider = makeProvider(http);
  await assert.rejects(() => provider.enable("sim-1"), (error) => {
    assert.ok(error instanceof TelnyxActionError);
    assert.equal(error.statusValue, "failed");
    assert.match(String(error.message), /carrier blocked the sim/);
    return true;
  });
});

test("enable throws TelnyxActionTimeoutError when the action never terminates", async () => {
  const http = new FakeHttp()
    .on("/sim_cards/sim-1/actions/enable", () => ({
      data: { id: "act-1", status: { value: "in-progress" } },
    }))
    .on("/sim_card_actions/act-1", () => ({
      data: { id: "act-1", status: { value: "in-progress" } },
    }));

  // Fake clock that leaps forward on each read so the deadline is crossed.
  let clock = 0;
  const provider = new TelnyxProvider({
    apiKey: "test-key",
    simGroupId: "group-1",
    httpClient: http,
    sleep: async () => {},
    now: () => (clock += 100_000),
    actionTimeoutMs: 1_000,
  });

  await assert.rejects(
    () => provider.enable("sim-1"),
    (error) => error instanceof TelnyxActionTimeoutError,
  );
});

// --- setDataLimit ---

test("setDataLimit patches the standing data_limit in MB", async () => {
  const http = new FakeHttp().on("/sim_cards/sim-1", () => ({ data: { id: "sim-1" } }));

  const provider = makeProvider(http);
  await provider.setDataLimit("sim-1", 42);

  const patch = http.calls.find((c) => c.method === "PATCH" && c.url === "/sim_cards/sim-1");
  assert.ok(patch, "se llama al PATCH del SIM");
  assert.deepEqual(patch!.body, { data_limit: { amount: "42", unit: "MB" } });
});

test("setDataLimit rejects negative or NaN megabytes", async () => {
  const http = new FakeHttp();
  const provider = makeProvider(http);
  await assert.rejects(() => provider.setDataLimit("sim-1", -1), RangeError);
  await assert.rejects(() => provider.setDataLimit("sim-1", Number.NaN), RangeError);
});

// --- getUsage (raw MB, no conversion) ---

test("getUsage returns MB exactly as reported, without converting to bytes", async () => {
  const http = new FakeHttp().on("/sim_cards/sim-1", () => ({
    data: {
      id: "sim-1",
      status: { value: "enabled" },
      current_billing_period_consumed_data: { amount: "12.5", unit: "MB" },
    },
  }));

  const provider = makeProvider(http);
  const usage = await provider.getUsage("sim-1");

  assert.equal(usage.mb, 12.5);
  assert.equal(usage.status, "enabled");
});

test("getUsage reports 0 MB when the API omits consumption", async () => {
  const http = new FakeHttp().on("/sim_cards/sim-1", () => ({
    data: { id: "sim-1", status: { value: "disabled" } },
  }));

  const provider = makeProvider(http);
  const usage = await provider.getUsage("sim-1");

  assert.equal(usage.mb, 0);
  assert.equal(usage.status, "disabled");
});

test("getUsage propagates transport errors", async () => {
  const http = new FakeHttp().on("/sim_cards/sim-1", () => ({ data: {} }));
  http.nextRejects(new Error("network down"));

  const provider = makeProvider(http);
  await assert.rejects(() => provider.getUsage("sim-1"), /network down/);
});

// --- createTelnyxProvider (env fail-fast) ---

test("createTelnyxProvider requires TELNYX_API_KEY", () => {
  assert.throws(() => createTelnyxProvider({}), /TELNYX_API_KEY/);
});

test("createTelnyxProvider requires TELNYX_SIM_GROUP_ID after the key", () => {
  assert.throws(() => createTelnyxProvider({ TELNYX_API_KEY: "k" }), /TELNYX_SIM_GROUP_ID/);
  assert.ok(createTelnyxProvider({ TELNYX_API_KEY: "k", TELNYX_SIM_GROUP_ID: "g" }) instanceof TelnyxProvider);
});