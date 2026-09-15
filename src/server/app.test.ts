// Integration-style tests for the payment server's Express app (T3.2, T4.1).
// Only the ChargePort and the boot's readiness state are faked — everything
// else (Express, the Fetch bridge in routes/charge.ts, requireReady,
// health.ts) runs for real over a real HTTP connection on an ephemeral port.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "./app.ts";
import type { ChargeOutcome, ChargePort } from "./charge-service.ts";
import type { BuildResult, FailClosedBoot } from "../config/boot.ts";
import { message2UnsignedSchema } from "../shared/messages.ts";

const NETWORK = "stellar:testnet";
const EXPLORER_BASE_URL = "https://stellar.expert/explorer/testnet";
const PRICE_PER_MIB_RAW = 10_000n;

function fakeBoot(state: BuildResult<ChargePort>): FailClosedBoot<ChargePort> {
  return {
    getState: () => state,
    ensureReady: async () => state,
  };
}

function fakeChargePort(handle: ChargePort["handle"]): ChargePort {
  return { handle };
}

async function withApp(
  boot: FailClosedBoot<ChargePort>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = createServerApp({
    boot,
    network: NETWORK,
    explorerBaseUrl: EXPLORER_BASE_URL,
    pricePerMibRaw: PRICE_PER_MIB_RAW,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /health is always 200, regardless of readiness", async () => {
  const boot = fakeBoot({ status: "unavailable", reason: "config_invalid", detail: "boom" });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "alive");
  });
});

test("GET /ready reflects the boot state (200 when ready)", async () => {
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(async () => {
      throw new Error("unused");
    }),
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "ready");
  });
});

test("GET /ready reflects the boot state (503 with reason/detail when unavailable)", async () => {
  const boot = fakeBoot({
    status: "unavailable",
    reason: "config_invalid",
    detail: "invalid or missing environment variable(s): COMMITMENT_PUBKEY",
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { status: string; reason: string; detail: string };
    assert.equal(body.status, "unavailable");
    assert.equal(body.reason, "config_invalid");
    assert.match(body.detail, /COMMITMENT_PUBKEY/);
  });
});

test("GET /paid-resource when not ready responds 503 + M2 envelope + Retry-After, never reaching the charge route (FC-R5, FC-R6)", async () => {
  const boot = fakeBoot({
    status: "unavailable",
    reason: "upstream_unavailable",
    detail: "Soroban RPC unreachable",
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/paid-resource`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    const body = message2UnsignedSchema.parse(await response.json());
    assert.equal(body.status, "unsigned");
    assert.equal(body.reason, "upstream_unavailable");
    assert.equal(body.retryable, true);
  });
});

test("GET /paid-resource without a credential returns the 402 challenge unchanged (S1-R1)", async () => {
  const challengeBody = { challenge: true };
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(
      async (): Promise<ChargeOutcome> => ({
        kind: "challenge",
        response: new Response(JSON.stringify(challengeBody), {
          status: 402,
          headers: { "www-authenticate": "MPP" },
        }),
      }),
    ),
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/paid-resource`);
    assert.equal(response.status, 402);
    assert.equal(response.headers.get("www-authenticate"), "MPP");
    assert.deepEqual(await response.json(), challengeBody);
  });
});

test("GET /paid-resource with a credential settles and returns payment.txHash/explorerUrl/network (S1-R4)", async () => {
  const txHash = "b".repeat(64);
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(
      async (): Promise<ChargeOutcome> => ({
        kind: "settled",
        txHash,
        buildResponse: (body) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ),
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/paid-resource`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { payment: { txHash: string; network: string } };
    assert.equal(body.payment.txHash, txHash);
    assert.equal(body.payment.network, NETWORK);
  });
});

test("GET /paid-resource with a failing charge returns an M2 unsigned envelope (S1-R6)", async () => {
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(
      async (): Promise<ChargeOutcome> => ({
        kind: "failed",
        reason: "amount_rejected",
        detail: "expected 10000, received 5000",
      }),
    ),
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/paid-resource`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(response.status, 200);
    const body = message2UnsignedSchema.parse(await response.json());
    assert.equal(body.reason, "amount_rejected");
    assert.equal(body.retryable, false);
  });
});
