import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createMppChargeClient,
  runOneShotPurchase,
  parsePurchaseResult,
  type ChargeClientPort,
} from "./charge-client.ts";
import { buildUnsigned } from "../shared/messages.ts";

// A well-formed (valid strkey checksum) test seed. `Keypair.fromSecret()`
// validates the checksum, unlike `config/env.ts`'s format-only regex check —
// a syntactically S...56-char string is not enough here.
const VALID_SIGNER_SECRET = Keypair.random().secret();

test("runOneShotPurchase delegates to the port and returns its outcome unchanged (pull mode, fake)", async () => {
  const outcome = {
    kind: "settled" as const,
    receipt: {
      txHash: "c".repeat(64),
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + "c".repeat(64),
      network: "stellar:testnet",
      payload: { message: "paid content" },
    },
  };
  let calledWith: string | undefined;
  const fakePort: ChargeClientPort = {
    async purchase(url) {
      calledWith = url;
      return outcome;
    },
  };

  const result = await runOneShotPurchase(fakePort, "http://127.0.0.1:8080/paid-resource");

  assert.equal(calledWith, "http://127.0.0.1:8080/paid-resource");
  assert.deepEqual(result, outcome);
});

test("the fake port never simulates any XLM balance change (S1-R3): purchase() is the only call the client makes", async () => {
  let purchaseCalls = 0;
  const fakePort: ChargeClientPort = {
    async purchase() {
      purchaseCalls += 1;
      return {
        kind: "settled",
        receipt: {
          txHash: "d".repeat(64),
          explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + "d".repeat(64),
          network: "stellar:testnet",
          payload: {},
        },
      };
    },
  };

  await runOneShotPurchase(fakePort, "http://127.0.0.1:8080/paid-resource");

  assert.equal(purchaseCalls, 1, "exactly one paid request — no separate fee-paying call exists");
});

test("runOneShotPurchase propagates a rejected purchase instead of swallowing it", async () => {
  const fakePort: ChargeClientPort = {
    async purchase() {
      throw new Error("stage 1 purchase failed: HTTP 503");
    },
  };

  await assert.rejects(
    () => runOneShotPurchase(fakePort, "http://127.0.0.1:8080/paid-resource"),
    /HTTP 503/,
  );
});

test("createMppChargeClient builds a ChargeClientPort without making any network call", () => {
  // Construction only — Mppx.create() with polyfill:false never touches
  // globalThis.fetch or the network; only calling .purchase() would.
  const port = createMppChargeClient(VALID_SIGNER_SECRET);
  assert.equal(typeof port.purchase, "function");
});

test("createMppChargeClient rejects a malformed signer secret immediately", () => {
  assert.throws(() => createMppChargeClient("not-a-secret"));
});

// T8.2 open finding #1: `GET /paid-resource` `200` does not always carry a
// settled payment. These test the pure response-parsing core directly
// (design 4.1's testability rule — no real `Response`/SDK needed).

test("parsePurchaseResult: 200 with payment fields returns a settled outcome", () => {
  const body = {
    payload: { message: "payment settled" },
    payment: {
      txHash: "a".repeat(64),
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + "a".repeat(64),
      network: "stellar:testnet",
    },
  };

  const result = parsePurchaseResult(200, null, body);

  assert.deepEqual(result, {
    kind: "settled",
    receipt: {
      txHash: "a".repeat(64),
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + "a".repeat(64),
      network: "stellar:testnet",
      payload: { message: "payment settled" },
    },
  });
});

test("parsePurchaseResult: 200 M2 unsigned stale_reading returns a non-retryable outcome instead of throwing", () => {
  const { body, status } = buildUnsigned("stale_reading", {
    sessionId: "default",
    remaining: "0",
    meterReadingId: null,
    detail: "cumulativeBytes 1048576 is not greater than the last billed value 1048576",
  });
  assert.equal(status, 200);

  const result = parsePurchaseResult(status, null, body);

  assert.deepEqual(result, {
    kind: "unsigned",
    reason: "stale_reading",
    retryable: false,
    detail: body.detail,
    retryAfterSeconds: null,
  });
});

test("parsePurchaseResult: 503 M2 unsigned retryable reason returns retryAfterSeconds from the header", () => {
  const { body, status } = buildUnsigned("signer_unavailable", {
    sessionId: "default",
    meterReadingId: null,
    detail: "signer temporarily unavailable",
  });
  assert.equal(status, 503);

  const result = parsePurchaseResult(status, "5", body);

  assert.deepEqual(result, {
    kind: "unsigned",
    reason: "signer_unavailable",
    retryable: true,
    detail: body.detail,
    retryAfterSeconds: 5,
  });
});

test("parsePurchaseResult: 503 M2 unsigned with no Retry-After header still returns a typed outcome (retryAfterSeconds null)", () => {
  const { body, status } = buildUnsigned("upstream_unavailable", {
    sessionId: "default",
    meterReadingId: null,
    detail: "RPC unreachable",
  });

  const result = parsePurchaseResult(status, null, body);

  assert.equal(result.kind, "unsigned");
  if (result.kind === "unsigned") {
    assert.equal(result.retryAfterSeconds, null);
  }
});

test("parsePurchaseResult: malformed body (neither payment nor a valid M2 unsigned envelope) throws a clear error", () => {
  assert.throws(
    () => parsePurchaseResult(200, null, { unexpected: "shape" }),
    /missing payment\.txHash\/explorerUrl\/network/,
  );
});

test("parsePurchaseResult: a non-2xx status with no usable M2 envelope throws naming the status and body", () => {
  assert.throws(() => parsePurchaseResult(500, null, { error: "boom" }), /HTTP 500/);
});
