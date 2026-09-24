import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHex64,
  isHex128,
  isStellarAccountId,
  isStellarContractId,
  isStellarSecretSeed,
} from "./keys.ts";

const validAccountId = `G${"A".repeat(55)}`;
const validContractId = `C${"A".repeat(55)}`;
const validSecretSeed = `S${"A".repeat(55)}`;

test("isStellarAccountId accepts a well-formed G... id and rejects everything else", () => {
  assert.equal(isStellarAccountId(validAccountId), true);
  assert.equal(isStellarAccountId(validContractId), false);
  assert.equal(isStellarAccountId(`G${"A".repeat(54)}`), false); // too short
  assert.equal(isStellarAccountId(`G${"a".repeat(55)}`), false); // lowercase not valid base32
  assert.equal(isStellarAccountId(123), false);
});

test("isStellarContractId accepts a well-formed C... id and rejects everything else", () => {
  assert.equal(isStellarContractId(validContractId), true);
  assert.equal(isStellarContractId(validAccountId), false);
  assert.equal(isStellarContractId(`C${"A".repeat(56)}`), false); // too long
});

test("isStellarSecretSeed accepts a well-formed S... seed and rejects everything else", () => {
  assert.equal(isStellarSecretSeed(validSecretSeed), true);
  assert.equal(isStellarSecretSeed(validAccountId), false);
});

test("isHex64 accepts exactly 64 hex chars", () => {
  assert.equal(isHex64("a".repeat(64)), true);
  assert.equal(isHex64("A".repeat(64)), true);
  assert.equal(isHex64("a".repeat(63)), false);
  assert.equal(isHex64("g".repeat(64)), false);
});

test("isHex128 accepts exactly 128 hex chars", () => {
  assert.equal(isHex128("a".repeat(128)), true);
  assert.equal(isHex128("a".repeat(127)), false);
  assert.equal(isHex128("a".repeat(64)), false);
});
