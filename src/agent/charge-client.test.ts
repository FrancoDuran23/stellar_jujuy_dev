import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { createMppChargeClient, runOneShotPurchase, type ChargeClientPort } from "./charge-client.ts";

// A well-formed (valid strkey checksum) test seed. `Keypair.fromSecret()`
// validates the checksum, unlike `config/env.ts`'s format-only regex check —
// a syntactically S...56-char string is not enough here.
const VALID_SIGNER_SECRET = Keypair.random().secret();

test("runOneShotPurchase delegates to the port and returns its receipt unchanged (pull mode, fake)", async () => {
  const receipt = {
    txHash: "c".repeat(64),
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + "c".repeat(64),
    network: "stellar:testnet",
    payload: { message: "paid content" },
  };
  let calledWith: string | undefined;
  const fakePort: ChargeClientPort = {
    async purchase(url) {
      calledWith = url;
      return receipt;
    },
  };

  const result = await runOneShotPurchase(fakePort, "http://127.0.0.1:8080/paid-resource");

  assert.equal(calledWith, "http://127.0.0.1:8080/paid-resource");
  assert.deepEqual(result, receipt);
});

test("the fake port never simulates any XLM balance change (S1-R3): purchase() is the only call the client makes", async () => {
  let purchaseCalls = 0;
  const fakePort: ChargeClientPort = {
    async purchase() {
      purchaseCalls += 1;
      return {
        txHash: "d".repeat(64),
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + "d".repeat(64),
        network: "stellar:testnet",
        payload: {},
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
