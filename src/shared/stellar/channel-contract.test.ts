// Offline tests for the commitment codec + signing primitives (T6.2). Never
// touches the network — the XDR map is built locally with the same
// `@stellar/stellar-sdk` primitives the real `prepare_commitment` simulation
// result would decode to (verified byte-for-byte against the spike's live
// hex dump, docs/sdd/payments-mpp.md §6 / scratchpad spike Part A).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { StrKey, xdr, nativeToScVal } from "@stellar/stellar-sdk";
import {
  assertCommitmentBinds,
  commitmentKeypairFromHexSeed,
  decodeCommitmentBytes,
  signCommitmentBytes,
  verifyCommitmentSignature,
} from "./channel-contract.ts";

const NETWORK = "stellar:testnet" as const;
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 9));

function buildCommitmentBytes(overrides: {
  domain?: string;
  channel?: string;
  amount?: bigint;
  networkHash?: Buffer;
}): Buffer {
  const networkHash =
    overrides.networkHash ?? createHash("sha256").update(NETWORK_PASSPHRASE).digest();
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("amount", { type: "symbol" }),
      val: nativeToScVal(overrides.amount ?? 1_000_000n, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("channel", { type: "symbol" }),
      val: nativeToScVal(overrides.channel ?? CHANNEL, { type: "address" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("domain", { type: "symbol" }),
      val: nativeToScVal(overrides.domain ?? "chancmmt", { type: "symbol" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("network", { type: "symbol" }),
      val: nativeToScVal(networkHash, { type: "bytes" }),
    }),
  ]);
  return Buffer.from(map.toXDR());
}

test("decodeCommitmentBytes decodes the exact map shape prepare_commitment returns", () => {
  const bytes = buildCommitmentBytes({ amount: 42n });
  const decoded = decodeCommitmentBytes(bytes);
  assert.equal(decoded.domain, "chancmmt");
  assert.equal(decoded.channel, CHANNEL);
  assert.equal(decoded.amount, 42n);
  assert.equal(decoded.networkHash.length, 32);
});

test("assertCommitmentBinds passes for a matching channel/amount/network", () => {
  const bytes = buildCommitmentBytes({ channel: CHANNEL, amount: 5_000_000n });
  assert.doesNotThrow(() =>
    assertCommitmentBinds(bytes, { channel: CHANNEL, amount: 5_000_000n, network: NETWORK }),
  );
});

test("assertCommitmentBinds rejects a wrong channel (anti-tampering)", () => {
  const bytes = buildCommitmentBytes({ channel: OTHER_CHANNEL, amount: 1n });
  assert.throws(
    () => assertCommitmentBinds(bytes, { channel: CHANNEL, amount: 1n, network: NETWORK }),
    /channel mismatch/,
  );
});

test("assertCommitmentBinds rejects a wrong amount", () => {
  const bytes = buildCommitmentBytes({ channel: CHANNEL, amount: 1n });
  assert.throws(
    () => assertCommitmentBinds(bytes, { channel: CHANNEL, amount: 2n, network: NETWORK }),
    /amount mismatch/,
  );
});

test("assertCommitmentBinds rejects a wrong domain", () => {
  const bytes = buildCommitmentBytes({ domain: "not-chancmmt", channel: CHANNEL, amount: 1n });
  assert.throws(
    () => assertCommitmentBinds(bytes, { channel: CHANNEL, amount: 1n, network: NETWORK }),
    /domain mismatch/,
  );
});

test("assertCommitmentBinds rejects a wrong network hash", () => {
  const bytes = buildCommitmentBytes({
    channel: CHANNEL,
    amount: 1n,
    networkHash: randomBytes(32),
  });
  assert.throws(
    () => assertCommitmentBinds(bytes, { channel: CHANNEL, amount: 1n, network: NETWORK }),
    /network mismatch/,
  );
});

const TEST_SEED_HEX = randomBytes(32).toString("hex");

test("signCommitmentBytes is deterministic (RFC 8032): same input, same signature", () => {
  const bytes = buildCommitmentBytes({ amount: 7n });
  const first = signCommitmentBytes(TEST_SEED_HEX, bytes);
  const second = signCommitmentBytes(TEST_SEED_HEX, bytes);
  assert.equal(first.signature, second.signature);
  assert.equal(first.commitmentPubkey, second.commitmentPubkey);
  assert.match(first.signature, /^[0-9a-f]{128}$/);
  assert.match(first.commitmentPubkey, /^[0-9a-f]{64}$/);
});

test("signCommitmentBytes produces a different signature for a different amount", () => {
  const a = signCommitmentBytes(TEST_SEED_HEX, buildCommitmentBytes({ amount: 1n }));
  const b = signCommitmentBytes(TEST_SEED_HEX, buildCommitmentBytes({ amount: 2n }));
  assert.notEqual(a.signature, b.signature);
  assert.equal(a.commitmentPubkey, b.commitmentPubkey);
});

test("verifyCommitmentSignature accepts a real signature and rejects a tampered one", () => {
  const bytes = buildCommitmentBytes({ amount: 99n });
  const { signature, commitmentPubkey } = signCommitmentBytes(TEST_SEED_HEX, bytes);
  assert.equal(verifyCommitmentSignature(commitmentPubkey, bytes, signature), true);

  const tamperedBytes = buildCommitmentBytes({ amount: 100n });
  assert.equal(verifyCommitmentSignature(commitmentPubkey, tamperedBytes, signature), false);

  const wrongSignatureHex = "00".repeat(64);
  assert.equal(verifyCommitmentSignature(commitmentPubkey, bytes, wrongSignatureHex), false);
});

test("commitmentKeypairFromHexSeed's public key matches what signCommitmentBytes reports", () => {
  const keypair = commitmentKeypairFromHexSeed(TEST_SEED_HEX);
  const { commitmentPubkey } = signCommitmentBytes(TEST_SEED_HEX, buildCommitmentBytes({}));
  assert.equal(Buffer.from(keypair.rawPublicKey()).toString("hex"), commitmentPubkey);
});
