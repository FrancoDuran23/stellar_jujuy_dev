import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAgentApp } from "./app.ts";
import type { VoucherService } from "./routes/vouchers.ts";
import type { BuildResult, FailClosedBoot } from "../config/boot.ts";

const GATEWAY_TOKEN = "test-gateway-token";

function fakeBoot(state: BuildResult<VoucherService>): FailClosedBoot<VoucherService> {
  return {
    getState: () => state,
    ensureReady: async () => state,
  };
}

function fakeVoucherService(handle: VoucherService["handle"]): VoucherService {
  return { handle };
}

test("GET /health is 200 while the agent process is alive", async () => {
  const boot = fakeBoot({ status: "unavailable", reason: "config_invalid", detail: "boom" });
  const app = createAgentApp({ boot, gatewayToken: GATEWAY_TOKEN });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "alive");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("GET /health is 200 even while the vouchers instance is unavailable (FC-R6)", async () => {
  const boot = fakeBoot({ status: "unavailable", reason: "voucher_log_corrupt", detail: "boom" });
  const app = createAgentApp({ boot, gatewayToken: GATEWAY_TOKEN });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("POST /vouchers when not ready responds 503 + M2 envelope + Retry-After, never reaching the vouchers route (FC-R5, FC-R6)", async () => {
  const boot = fakeBoot({
    status: "unavailable",
    reason: "voucher_log_corrupt",
    detail: "voucher log has a corrupt line that is not the last one",
  });
  const app = createAgentApp({ boot, gatewayToken: GATEWAY_TOKEN });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": GATEWAY_TOKEN },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    const body = (await response.json()) as { status: string; reason: string; retryable: boolean };
    assert.equal(body.status, "unsigned");
    assert.equal(body.reason, "internal_error"); // voucher_log_corrupt is alarm-only, mapped via toM2Reason
    assert.equal(body.retryable, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("POST /vouchers when ready delegates to the boot's live instance", async () => {
  const boot = fakeBoot({
    status: "ready",
    instance: fakeVoucherService(async (m1) => ({
      body: {
        version: 1,
        status: "signed",
        sessionId: m1.sessionId,
        channel: m1.channel,
        voucher: {
          cumulativeAmount: m1.cumulativeAmount,
          signature: "a".repeat(128),
          commitmentPubkey: "b".repeat(64),
          network: m1.network,
        },
        meterReadingId: m1.meterReadingId,
        reused: false,
        remaining: "875000",
        signedAt: "2026-09-20T18:04:02.118Z",
      },
      status: 200,
    })),
  });
  const app = createAgentApp({ boot, gatewayToken: GATEWAY_TOKEN });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": GATEWAY_TOKEN },
      body: JSON.stringify({
        version: 1,
        sessionId: "sess_1",
        channel: `C${"A".repeat(55)}`,
        network: "stellar:testnet",
        asset: "USDC",
        cumulativeBytes: 1048576,
        cumulativeAmount: "10000",
        meterReadingId: "mr_1",
        observedAt: "2026-09-20T18:04:02.118Z",
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; voucher: { cumulativeAmount: string } };
    assert.equal(body.status, "signed");
    assert.equal(body.voucher.cumulativeAmount, "10000");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
