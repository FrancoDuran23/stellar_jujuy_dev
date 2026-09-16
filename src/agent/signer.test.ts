import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSigner } from "./signer.ts";
import { isHex64, isHex128 } from "../shared/stellar/keys.ts";

const CHANNEL = `C${"A".repeat(55)}`;

test("createFakeSigner produces a well-formed signature and commitmentPubkey", async () => {
  const signer = createFakeSigner();
  const result = await signer.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "125000" });
  assert.ok(isHex128(result.signature));
  assert.ok(isHex64(result.commitmentPubkey));
});

test("createFakeSigner is deterministic: same input always yields the same signature (RFC 8032 property, design 4.2)", async () => {
  const signer = createFakeSigner();
  const first = await signer.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "125000" });
  const second = await signer.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "125000" });
  assert.equal(first.signature, second.signature);
  assert.equal(first.commitmentPubkey, second.commitmentPubkey);
});

test("createFakeSigner produces a different signature for a different cumulativeAmount", async () => {
  const signer = createFakeSigner();
  const first = await signer.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "125000" });
  const second = await signer.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "150000" });
  assert.notEqual(first.signature, second.signature);
  // The commitment pubkey is fixed per signer instance, like a real keypair.
  assert.equal(first.commitmentPubkey, second.commitmentPubkey);
});

test("two independently seeded signers never collide", async () => {
  const a = createFakeSigner("signer-a");
  const b = createFakeSigner("signer-b");
  const inputA = await a.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "1" });
  const inputB = await b.sign({ channel: CHANNEL, network: "stellar:testnet", cumulativeAmount: "1" });
  assert.notEqual(inputA.commitmentPubkey, inputB.commitmentPubkey);
  assert.notEqual(inputA.signature, inputB.signature);
});
