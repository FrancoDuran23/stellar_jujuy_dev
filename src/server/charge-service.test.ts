import { test } from "node:test";
import assert from "node:assert/strict";
import { createChargeService, type ChargePort } from "./charge-service.ts";
import type { EmitInput } from "../shared/events.ts";
import { message2UnsignedSchema } from "../shared/messages.ts";

const NETWORK = "stellar:testnet";
const EXPLORER_BASE_URL = "https://stellar.expert/explorer/testnet";

function fakePort(handle: ChargePort["handle"]): ChargePort {
  return { handle };
}

test("challenge outcome is passed through unchanged and nothing is emitted", async () => {
  const challengeResponse = new Response(JSON.stringify({ challenge: true }), { status: 402 });
  const events: EmitInput[] = [];
  const handleCharge = createChargeService({
    chargePort: fakePort(async () => ({ kind: "challenge", response: challengeResponse })),
    network: NETWORK,
    explorerBaseUrl: EXPLORER_BASE_URL,
    emit: (input) => events.push(input),
  });

  const result = await handleCharge(new Request("http://localhost/paid-resource"), {
    sessionId: "sess_1",
    amountRaw: "10000",
  });

  assert.equal(result.settled, false);
  assert.equal(result.response, challengeResponse);
  assert.equal(result.response.status, 402);
  assert.deepEqual(events, []);
});

test("settled outcome adds payment.txHash/explorerUrl/network and emits charge.settled (S1-R4)", async () => {
  const events: EmitInput[] = [];
  const txHash = "a".repeat(64);
  const handleCharge = createChargeService({
    chargePort: fakePort(async () => ({
      kind: "settled",
      txHash,
      buildResponse: (body) => new Response(JSON.stringify(body), { status: 200 }),
    })),
    network: NETWORK,
    explorerBaseUrl: EXPLORER_BASE_URL,
    emit: (input) => events.push(input),
  });

  const result = await handleCharge(new Request("http://localhost/paid-resource"), {
    sessionId: "sess_1",
    amountRaw: "10000",
  });

  assert.equal(result.settled, true);
  assert.equal(result.response.status, 200);
  const body = (await result.response.json()) as { payment: unknown };
  assert.deepEqual(body.payment, {
    txHash,
    explorerUrl: `${EXPLORER_BASE_URL}/tx/${txHash}`,
    network: NETWORK,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "charge.settled");
  assert.equal(events[0]!.sessionId, "sess_1");
  assert.deepEqual(events[0]!.data, {
    amountRaw: "10000",
    txHash,
    explorerUrl: `${EXPLORER_BASE_URL}/tx/${txHash}`,
    network: NETWORK,
  });
});

test("failed outcome returns an M2 unsigned envelope with reason/retryable and emits payment.failed (S1-R6)", async () => {
  const events: EmitInput[] = [];
  const handleCharge = createChargeService({
    chargePort: fakePort(async () => ({
      kind: "failed",
      reason: "upstream_unavailable",
      detail: "Soroban RPC unreachable",
    })),
    network: NETWORK,
    explorerBaseUrl: EXPLORER_BASE_URL,
    emit: (input) => events.push(input),
  });

  const result = await handleCharge(new Request("http://localhost/paid-resource"), {
    sessionId: "sess_1",
    amountRaw: "10000",
  });

  assert.equal(result.settled, false);
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("retry-after"), "5");
  const body = message2UnsignedSchema.parse(await result.response.json());
  assert.equal(body.status, "unsigned");
  assert.equal(body.reason, "upstream_unavailable");
  assert.equal(body.retryable, true);
  assert.equal(body.sessionId, "sess_1");

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "payment.failed");
  assert.deepEqual(events[0]!.data, {
    reason: "upstream_unavailable",
    detail: "Soroban RPC unreachable",
  });
});

test("a failed outcome mapped to HTTP 200 (e.g. amount_rejected) is still settled: false", async () => {
  const handleCharge = createChargeService({
    chargePort: fakePort(async () => ({
      kind: "failed",
      reason: "amount_rejected",
      detail: "expected 10000, received 5000",
    })),
    network: NETWORK,
    explorerBaseUrl: EXPLORER_BASE_URL,
  });

  const result = await handleCharge(new Request("http://localhost/paid-resource"), {
    sessionId: null,
    amountRaw: "5000",
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.settled, false, "status 200 must never be confused with a settlement");
});
