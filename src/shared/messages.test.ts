import { test } from "node:test";
import assert from "node:assert/strict";
import {
  message1Schema,
  message2Schema,
  message2SignedSchema,
  message2UnsignedSchema,
} from "./messages.ts";

const canonicalMessage1 = {
  version: 1,
  sessionId: "sess_01JBQ7X3M2",
  channel: "C".padEnd(56, "A"),
  network: "stellar:testnet",
  asset: "USDC",
  cumulativeBytes: 1048576,
  cumulativeAmount: "125000",
  meterReadingId: "mr_000042",
  observedAt: "2026-09-17T14:03:11.204Z",
};

test("message1Schema accepts the canonical payload", () => {
  const result = message1Schema.safeParse(canonicalMessage1);
  assert.equal(result.success, true);
});

test("message1Schema accepts a stage-1 payload without channel (VE-R5)", () => {
  const { channel: _channel, ...withoutChannel } = canonicalMessage1;
  const result = message1Schema.safeParse(withoutChannel);
  assert.equal(result.success, true);
});

test("message1Schema rejects a missing required field", () => {
  const { sessionId: _sessionId, ...missingSessionId } = canonicalMessage1;
  const result = message1Schema.safeParse(missingSessionId);
  assert.equal(result.success, false);
});

test("message1Schema rejects cumulativeAmount as a JSON number (VE-R3)", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeAmount: 125000 });
  assert.equal(result.success, false);
});

test("message1Schema rejects cumulativeAmount as a decimal string (VE-R3)", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeAmount: "0.0125" });
  assert.equal(result.success, false);
});

test("message1Schema rejects a negative cumulativeBytes (VE-R4)", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeBytes: -1 });
  assert.equal(result.success, false);
});

test("message1Schema rejects an unknown network", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, network: "stellar:mainnet" });
  assert.equal(result.success, false);
});

test("message1Schema rejects a channel of invalid length", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, channel: "C123" });
  assert.equal(result.success, false);
});

const canonicalSigned = {
  version: 1,
  status: "signed",
  sessionId: "sess_01JBQ7X3M2",
  channel: "C".padEnd(56, "A"),
  voucher: {
    cumulativeAmount: "125000",
    signature: "a".repeat(128),
    commitmentPubkey: "b".repeat(64),
    network: "stellar:testnet",
  },
  meterReadingId: "mr_000042",
  reused: false,
  remaining: "9875000",
  signedAt: "2026-09-17T14:03:11.402Z",
};

test("message2SignedSchema accepts the canonical signed payload (VE-R7)", () => {
  assert.equal(message2SignedSchema.safeParse(canonicalSigned).success, true);
});

test("message2SignedSchema rejects a signature that is not 128 hex chars", () => {
  const bad = { ...canonicalSigned, voucher: { ...canonicalSigned.voucher, signature: "a".repeat(127) } };
  assert.equal(message2SignedSchema.safeParse(bad).success, false);
});

const canonicalUnsigned = {
  version: 1,
  status: "unsigned",
  sessionId: "sess_01JBQ7X3M2",
  channel: "C".padEnd(56, "A"),
  reason: "channel_exhausted",
  retryable: false,
  remaining: "0",
  meterReadingId: "mr_000042",
  detail: "requested cumulative 125000 exceeds channel deposit 100000",
};

test("message2UnsignedSchema accepts the canonical unsigned payload (VE-R8)", () => {
  assert.equal(message2UnsignedSchema.safeParse(canonicalUnsigned).success, true);
});

test("message2UnsignedSchema rejects an unknown reason", () => {
  const bad = { ...canonicalUnsigned, reason: "made_up_reason" };
  assert.equal(message2UnsignedSchema.safeParse(bad).success, false);
});

test("message2Schema discriminates signed vs unsigned by status", () => {
  assert.equal(message2Schema.safeParse(canonicalSigned).success, true);
  assert.equal(message2Schema.safeParse(canonicalUnsigned).success, true);
  assert.equal(message2Schema.safeParse({ ...canonicalSigned, status: "pending" }).success, false);
});
