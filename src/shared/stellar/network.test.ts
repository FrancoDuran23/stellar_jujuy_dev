import { test } from "node:test";
import assert from "node:assert/strict";
import { isNetwork, networkPassphrase } from "./network.ts";

test("isNetwork accepts the two known networks", () => {
  assert.equal(isNetwork("stellar:testnet"), true);
  assert.equal(isNetwork("stellar:pubnet"), true);
});

test("isNetwork rejects anything else", () => {
  assert.equal(isNetwork("stellar:mainnet"), false);
  assert.equal(isNetwork(""), false);
  assert.equal(isNetwork(123), false);
  assert.equal(isNetwork(undefined), false);
});

test("networkPassphrase returns a distinct, non-empty passphrase per network", () => {
  const testnet = networkPassphrase("stellar:testnet");
  const pubnet = networkPassphrase("stellar:pubnet");
  assert.ok(testnet.length > 0);
  assert.ok(pubnet.length > 0);
  assert.notEqual(testnet, pubnet);
});
