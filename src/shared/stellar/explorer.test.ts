import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExplorerUrl } from "./explorer.ts";
import { describeMissingTrustline } from "./trustline.ts";

test("buildExplorerUrl joins base and hash with /tx/", () => {
  assert.equal(
    buildExplorerUrl("https://stellar.expert/explorer/testnet", "deadbeef"),
    "https://stellar.expert/explorer/testnet/tx/deadbeef",
  );
});

test("buildExplorerUrl tolerates a trailing slash on the base URL", () => {
  assert.equal(
    buildExplorerUrl("https://stellar.expert/explorer/testnet/", "deadbeef"),
    "https://stellar.expert/explorer/testnet/tx/deadbeef",
  );
});

test("buildExplorerUrl rejects an empty tx hash", () => {
  assert.throws(() => buildExplorerUrl("https://stellar.expert/explorer/testnet", ""), RangeError);
});

test("describeMissingTrustline names the account and defaults to USDC", () => {
  const message = describeMissingTrustline("GABCDEF");
  assert.match(message, /GABCDEF/);
  assert.match(message, /USDC/);
});
