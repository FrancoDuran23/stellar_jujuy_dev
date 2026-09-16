import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { createChannelVouchersRoute } from "./channel.ts";
import type { ChannelService, VoucherAcceptOutcome } from "../channel-service.ts";

const CHANNEL = `C${"A".repeat(55)}`;

function fakeService(outcome: VoucherAcceptOutcome): ChannelService {
  return {
    async verifyAndAccept() {
      return outcome;
    },
    async closeChannel() {
      throw new Error("not used in this test");
    },
    getHighestRaw() {
      return 0n;
    },
  };
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    channel: CHANNEL,
    network: "stellar:testnet",
    cumulativeAmount: "1000",
    signature: "a".repeat(128),
    commitmentPubkey: "b".repeat(64),
    sessionId: "sess_1",
    cumulativeBytes: 1_048_576,
    meterReadingId: "mr_1",
    ...overrides,
  };
}

test("POST /channel/vouchers returns 200/accepted:true for an accepted commitment", async () => {
  const app = express();
  app.use(express.json());
  app.post("/channel/vouchers", createChannelVouchersRoute({ channelService: fakeService({ kind: "accepted", remainingRaw: 999_000n }) }));
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/channel/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { accepted: true, remaining: "999000" });
  } finally {
    await close();
  }
});

test("POST /channel/vouchers returns 200/accepted:false with the reason for a rejection (never a 4xx business status)", async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/channel/vouchers",
    createChannelVouchersRoute({ channelService: fakeService({ kind: "rejected", reason: "channel_exhausted", detail: "too much" }) }),
  );
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/channel/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { accepted: false, reason: "channel_exhausted", detail: "too much" });
  } finally {
    await close();
  }
});

test("POST /channel/vouchers rejects a malformed body with 400", async () => {
  const app = express();
  app.use(express.json());
  app.post("/channel/vouchers", createChannelVouchersRoute({ channelService: fakeService({ kind: "accepted", remainingRaw: 0n }) }));
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/channel/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ signature: "not-hex" })),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
