// Integration-style tests for the payment server's Express app (T3.2, T4.1).
// Only the ChargePort and the boot's readiness state are faked — everything
// else (Express, the Fetch bridge in routes/charge.ts, requireReady,
// health.ts) runs for real over a real HTTP connection on an ephemeral port.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "./app.ts";
import type { ChargeOutcome, ChargePort } from "./charge-service.ts";
import type { BuildResult, FailClosedBoot, ServerChannelInstance } from "../config/boot.ts";
import { message2UnsignedSchema } from "../shared/messages.ts";
import type { ChannelService, VoucherAcceptOutcome } from "./channel-service.ts";

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

function fakeChannelBoot(state: BuildResult<ServerChannelInstance>): FailClosedBoot<ServerChannelInstance> {
  return {
    getState: () => state,
    ensureReady: async () => state,
  };
}

function fakeChannelService(verifyAndAccept: ChannelService["verifyAndAccept"]): ChannelService {
  return {
    verifyAndAccept,
    async closeChannel() {
      throw new Error("not used in these tests");
    },
    getHighestRaw() {
      return 0n;
    },
  };
}

async function withApp(
  boot: FailClosedBoot<ChargePort>,
  fn: (baseUrl: string) => Promise<void>,
  extra: { channelBoot?: FailClosedBoot<ServerChannelInstance>; channel?: string } = {},
): Promise<void> {
  const app = createServerApp({
    boot,
    network: NETWORK,
    explorerBaseUrl: EXPLORER_BASE_URL,
    pricePerMibRaw: PRICE_PER_MIB_RAW,
    ...extra,
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

test("GET /paid-resource?cumulativeBytes=abc is a plain 400, never an uncaught BigInt SyntaxError (review finding 2)", async () => {
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(async (): Promise<ChargeOutcome> => {
      throw new Error("must not be called");
    }),
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/paid-resource?cumulativeBytes=abc`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /non-negative integer/);
  });
});

test("GET /paid-resource with a lower cumulativeBytes than previously billed is 200 M2 stale_reading, never a RangeError (review finding 2)", async () => {
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(
      async (): Promise<ChargeOutcome> => ({
        kind: "settled",
        txHash: "c".repeat(64),
        buildResponse: (body) =>
          new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      }),
    ),
  });
  await withApp(boot, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/paid-resource?sessionId=s1&cumulativeBytes=2097152`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/paid-resource?sessionId=s1&cumulativeBytes=1048576`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(second.status, 200);
    const body = message2UnsignedSchema.parse(await second.json());
    assert.equal(body.reason, "stale_reading");
    assert.equal(body.retryable, false);
  });
});

test("a second identical GET /paid-resource (amountRaw would be 0) is 200 M2 stale_reading, no charge attempt (review finding 3)", async () => {
  let chargeCalls = 0;
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(
      async (): Promise<ChargeOutcome> => {
        chargeCalls += 1;
        return {
          kind: "settled",
          txHash: "d".repeat(64),
          buildResponse: (body) =>
            new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
        };
      },
    ),
  });
  await withApp(boot, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/paid-resource?sessionId=s2&cumulativeBytes=1048576`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(first.status, 200);
    assert.equal(chargeCalls, 1);

    const second = await fetch(`${baseUrl}/paid-resource?sessionId=s2&cumulativeBytes=1048576`, {
      headers: { authorization: "fake-credential" },
    });
    assert.equal(second.status, 200);
    assert.equal(chargeCalls, 1, "the charge port must not be called again for a non-advancing reading");
    const body = message2UnsignedSchema.parse(await second.json());
    assert.equal(body.reason, "stale_reading");
    assert.equal(body.retryable, false);
  });
});

test("an uncaught error from a route never leaks an HTML stack trace (review finding 2)", async () => {
  const boot = fakeBoot({
    status: "ready",
    instance: fakeChargePort(async (): Promise<ChargeOutcome> => {
      throw new Error("boom: /d/sTelar/stellar_jujuy_dev/src/server/charge-service.ts");
    }),
  });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/paid-resource`, {
      headers: { authorization: "fake-credential" },
    });
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const text = await response.text();
    assert.doesNotMatch(text, /<html/i);
    assert.doesNotMatch(text, /at .*\.ts:\d+/);
    const body = message2UnsignedSchema.parse(JSON.parse(text));
    assert.equal(body.reason, "internal_error");
    assert.equal(body.retryable, true);
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

const CHANNEL = `C${"A".repeat(55)}`;

test("GET /ready adds stage 2 detail (channel, monitor state) once the channel boot is ready", async () => {
  const boot = fakeBoot({ status: "unavailable", reason: "config_invalid", detail: "stage 1 not configured" });
  const channelBoot = fakeChannelBoot({
    status: "ready",
    instance: {
      channelService: fakeChannelService(async () => {
        throw new Error("unused");
      }),
      closeMonitor: { start() {}, stop() {}, getState: () => ({ running: true, lastKnownClosing: false, lastError: undefined, lastPolledAt: "2026-09-16T00:00:00.000Z" }) },
    },
  });
  await withApp(
    boot,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ready`);
      // Primary (stage 1) boot is unavailable, so overall /ready is still 503 —
      // stage 2 detail is additive, never overrides the primary status.
      assert.equal(response.status, 503);
    },
    { channelBoot, channel: CHANNEL },
  );
});

test("POST /channel/vouchers returns 200/accepted:true when the channel instance is ready", async () => {
  const boot = fakeBoot({ status: "unavailable", reason: "config_invalid", detail: "stage 1 not configured" });
  const channelBoot = fakeChannelBoot({
    status: "ready",
    instance: {
      channelService: fakeChannelService(async (): Promise<VoucherAcceptOutcome> => ({ kind: "accepted", remainingRaw: 500n })),
      closeMonitor: { start() {}, stop() {}, getState: () => ({ running: false, lastKnownClosing: undefined, lastError: undefined, lastPolledAt: undefined }) },
    },
  });
  await withApp(
    boot,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/channel/vouchers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: CHANNEL,
          network: "stellar:testnet",
          cumulativeAmount: "1000",
          signature: "a".repeat(128),
          commitmentPubkey: "b".repeat(64),
          sessionId: "sess_1",
          cumulativeBytes: 1_048_576,
          meterReadingId: "mr_1",
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { accepted: true, remaining: "500" });
    },
    { channelBoot, channel: CHANNEL },
  );
});

test("POST /channel/vouchers is 503 when the channel instance is not ready and never reaches the service", async () => {
  const boot = fakeBoot({ status: "ready", instance: fakeChargePort(async () => { throw new Error("unused"); }) });
  const channelBoot = fakeChannelBoot({ status: "unavailable", reason: "config_invalid", detail: "stage 2 not configured" });
  await withApp(
    boot,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/channel/vouchers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 503);
      const body = (await response.json()) as { accepted: boolean };
      assert.equal(body.accepted, false);
    },
    { channelBoot, channel: CHANNEL },
  );
});

test("POST /channel/vouchers is 404 when stage 2 is not wired at all (no channelBoot)", async () => {
  const boot = fakeBoot({ status: "ready", instance: fakeChargePort(async () => { throw new Error("unused"); }) });
  await withApp(boot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/channel/vouchers`, { method: "POST" });
    assert.equal(response.status, 404);
  });
});
