import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnsigned,
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

test("message1Schema rejects a leading-zero cumulativeAmount (review finding, Lote C)", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeAmount: "007" });
  assert.equal(result.success, false);
});

test("message1Schema accepts \"0\" as cumulativeAmount", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeAmount: "0" });
  assert.equal(result.success, true);
});

test("message1Schema rejects a cumulativeAmount above the i128 maximum (review finding, Lote C)", () => {
  const tooLarge = (2n ** 127n).toString(); // one past 2**127 - 1
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeAmount: tooLarge });
  assert.equal(result.success, false);
});

test("message1Schema accepts exactly the i128 maximum as cumulativeAmount", () => {
  const max = (2n ** 127n - 1n).toString();
  const result = message1Schema.safeParse({ ...canonicalMessage1, cumulativeAmount: max });
  assert.equal(result.success, true);
});

test("message1Schema rejects an unknown top-level key (VE-R2, review finding Lote C: .strict())", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, extraField: "unexpected" });
  assert.equal(result.success, false);
});

test("message1Schema accepts observedAt with a non-UTC offset (review finding, Lote C)", () => {
  const result = message1Schema.safeParse({
    ...canonicalMessage1,
    observedAt: "2026-09-17T11:03:11.204+03:00",
  });
  assert.equal(result.success, true);
});

test("message1Schema rejects observedAt without a timezone designator", () => {
  const result = message1Schema.safeParse({ ...canonicalMessage1, observedAt: "2026-09-17T14:03:11.204" });
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

test("message2UnsignedSchema rejects retryable that disagrees with REASONS (review finding)", () => {
  const mismatched = { ...canonicalUnsigned, reason: "channel_exhausted", retryable: true };
  assert.equal(message2UnsignedSchema.safeParse(mismatched).success, false);
});

test("message2UnsignedSchema accepts retryable: true only for a retryable reason", () => {
  const retryable = {
    ...canonicalUnsigned,
    reason: "upstream_unavailable",
    retryable: true,
    detail: "Soroban RPC unreachable",
  };
  assert.equal(message2UnsignedSchema.safeParse(retryable).success, true);
});

test("message2UnsignedSchema accepts null sessionId and meterReadingId (fail-closed, pre-body-parse)", () => {
  const noBodyYet = { ...canonicalUnsigned, sessionId: null, meterReadingId: null };
  assert.equal(message2UnsignedSchema.safeParse(noBodyYet).success, true);
});

test("message2UnsignedSchema rejects empty-string sessionId or meterReadingId — null only, never a placeholder", () => {
  assert.equal(message2UnsignedSchema.safeParse({ ...canonicalUnsigned, sessionId: "" }).success, false);
  assert.equal(
    message2UnsignedSchema.safeParse({ ...canonicalUnsigned, meterReadingId: "" }).success,
    false,
  );
});

test("buildUnsigned derives retryable and HTTP status from REASONS, never from the caller", () => {
  const { body, status } = buildUnsigned("channel_exhausted", {
    sessionId: "sess_1",
    channel: "C".padEnd(56, "A"),
    remaining: "0",
    meterReadingId: "mr_1",
    detail: "deposit exhausted",
  });
  assert.equal(body.retryable, false);
  assert.equal(status, 200);

  const retryableCase = buildUnsigned("upstream_unavailable", {
    sessionId: null,
    meterReadingId: null,
    detail: "Soroban RPC unreachable",
  });
  assert.equal(retryableCase.body.retryable, true);
  assert.equal(retryableCase.status, 503);
  assert.equal(retryableCase.body.sessionId, null);
  assert.equal(retryableCase.body.meterReadingId, null);
  assert.equal(retryableCase.body.remaining, "0");
});
