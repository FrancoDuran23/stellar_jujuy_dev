import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentEnv, parseServerEnv } from "./env.ts";

const validServerEnv = {
  STELLAR_RECIPIENT: "G".padEnd(56, "A"),
  MPP_SECRET_KEY: "a-generic-non-empty-secret",
  FEE_PAYER_SECRET: "S".padEnd(56, "A"),
  PRICE_PER_MIB_RAW: "10000",
};

const validAgentEnv = {
  GATEWAY_TOKEN: "shared-secret",
  SIGNER_SECRET: "S".padEnd(56, "A"),
  PRICE_PER_MIB_RAW: "10000",
};

test("parseServerEnv accepts a minimal valid environment and applies defaults", () => {
  const result = parseServerEnv(validServerEnv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.PORT, 8080);
  assert.equal(result.value.STELLAR_NETWORK, "stellar:testnet");
  assert.equal(result.value.PRICE_PER_MIB_RAW, 10000n);
  assert.equal(typeof result.value.PRICE_PER_MIB_RAW, "bigint");
  assert.equal(result.value.CHANNEL_CONTRACT, undefined);
});

test("parseServerEnv rejects a malformed STELLAR_RECIPIENT", () => {
  const result = parseServerEnv({ ...validServerEnv, STELLAR_RECIPIENT: "not-an-account" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /STELLAR_RECIPIENT/);
});

test("parseServerEnv rejects a malformed CHANNEL_CONTRACT when present", () => {
  const result = parseServerEnv({ ...validServerEnv, CHANNEL_CONTRACT: "not-a-contract" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /CHANNEL_CONTRACT/);
});

test("parseServerEnv accepts a well-formed CHANNEL_CONTRACT with its stage-2 companions", () => {
  const result = parseServerEnv({
    ...validServerEnv,
    CHANNEL_CONTRACT: "C".padEnd(56, "A"),
    COMMITMENT_PUBKEY: "a".repeat(64),
    FUNDER_ACCOUNT: "G".padEnd(56, "B"),
  });
  assert.equal(result.ok, true);
});

test("parseServerEnv rejects CHANNEL_CONTRACT without COMMITMENT_PUBKEY/FUNDER_ACCOUNT (WU6 stage-2 gate)", () => {
  const result = parseServerEnv({ ...validServerEnv, CHANNEL_CONTRACT: "C".padEnd(56, "A") });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /COMMITMENT_PUBKEY/);
  assert.match(result.detail, /FUNDER_ACCOUNT/);
});

test("parseServerEnv rejects a malformed COMMITMENT_PUBKEY when present", () => {
  const result = parseServerEnv({ ...validServerEnv, COMMITMENT_PUBKEY: "not-hex" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /COMMITMENT_PUBKEY/);
});

test("parseServerEnv rejects a missing required variable", () => {
  const { MPP_SECRET_KEY: _omit, ...withoutSecret } = validServerEnv;
  const result = parseServerEnv(withoutSecret);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /MPP_SECRET_KEY/);
});

test("parseServerEnv detail never echoes the invalid value (CF-R3)", () => {
  const secretValue = "S3CR3T_LOOKING_VALUE";
  const result = parseServerEnv({ ...validServerEnv, STELLAR_RECIPIENT: secretValue });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.detail.includes(secretValue), false);
});

test("parseAgentEnv accepts a minimal valid environment and applies defaults", () => {
  const result = parseAgentEnv(validAgentEnv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.AGENT_PORT, 8081);
  assert.equal(result.value.MAX_DELTA_PER_REQUEST_RAW, 5_000_000n);
  assert.equal(result.value.PAYMENT_SERVER_URL, "http://127.0.0.1:8080");
});

test("parseAgentEnv does not read or require MPP_SECRET_KEY (orchestrator amendment)", () => {
  const result = parseAgentEnv(validAgentEnv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal("MPP_SECRET_KEY" in result.value, false);
});

test("parseAgentEnv rejects a malformed SIGNER_SECRET", () => {
  const result = parseAgentEnv({ ...validAgentEnv, SIGNER_SECRET: "not-a-secret" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /SIGNER_SECRET/);
});

test("parseAgentEnv rejects a malformed COMMITMENT_SECRET when present", () => {
  const result = parseAgentEnv({ ...validAgentEnv, COMMITMENT_SECRET: "not-a-secret" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /COMMITMENT_SECRET/);
});

test("parseAgentEnv rejects a COMMITMENT_SECRET that looks like raw hex instead of a Stellar secret seed", () => {
  // Regression: COMMITMENT_SECRET is a Stellar secret seed (S..., 56 chars),
  // the same format as SIGNER_SECRET/FEE_PAYER_SECRET — NOT a raw 32-byte
  // ed25519 seed hex string. An earlier revision of this schema (isHex64)
  // accepted exactly this shape and silently mis-parsed the real .env value.
  const result = parseAgentEnv({ ...validAgentEnv, COMMITMENT_SECRET: "a".repeat(64) });
  assert.equal(result.ok, false);
});

test("parseAgentEnv rejects CHANNEL_CONTRACT without COMMITMENT_SECRET (WU6 stage-2 gate)", () => {
  const result = parseAgentEnv({ ...validAgentEnv, CHANNEL_CONTRACT: "C".padEnd(56, "A") });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /COMMITMENT_SECRET/);
});

test("parseAgentEnv accepts CHANNEL_CONTRACT with COMMITMENT_SECRET", () => {
  const result = parseAgentEnv({
    ...validAgentEnv,
    CHANNEL_CONTRACT: "C".padEnd(56, "A"),
    COMMITMENT_SECRET: "S".padEnd(56, "B"),
  });
  assert.equal(result.ok, true);
});

test("both roles reject a non-positive PRICE_PER_MIB_RAW", () => {
  assert.equal(parseServerEnv({ ...validServerEnv, PRICE_PER_MIB_RAW: "0" }).ok, false);
  assert.equal(parseAgentEnv({ ...validAgentEnv, PRICE_PER_MIB_RAW: "0" }).ok, false);
});

test("both roles reject a decimal or non-digit PRICE_PER_MIB_RAW", () => {
  assert.equal(parseServerEnv({ ...validServerEnv, PRICE_PER_MIB_RAW: "0.5" }).ok, false);
  assert.equal(parseAgentEnv({ ...validAgentEnv, PRICE_PER_MIB_RAW: "abc" }).ok, false);
});

// dotenv parses a bare `KEY=` line (exactly what .env.example ships for every
// stage-2-only variable) as `""`, not `undefined`. zod's `.optional()` only
// ever accepts `undefined`, so without the `emptyToUndefined` preprocessing
// these placeholder lines made an otherwise-valid stage-1 `.env` fail to
// parse.
test("parseServerEnv treats an empty-string optional variable as unset, not invalid", () => {
  const result = parseServerEnv({
    ...validServerEnv,
    CHANNEL_CONTRACT: "",
    COMMITMENT_PUBKEY: "",
    FUNDER_ACCOUNT: "",
    BACKEND_EVENTS_URL: "",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.CHANNEL_CONTRACT, undefined);
  assert.equal(result.value.COMMITMENT_PUBKEY, undefined);
  assert.equal(result.value.FUNDER_ACCOUNT, undefined);
  assert.equal(result.value.BACKEND_EVENTS_URL, undefined);
});

test("parseAgentEnv treats an empty-string optional variable as unset, not invalid", () => {
  const result = parseAgentEnv({
    ...validAgentEnv,
    COMMITMENT_SECRET: "",
    CHANNEL_CONTRACT: "",
    BACKEND_EVENTS_URL: "",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.COMMITMENT_SECRET, undefined);
  assert.equal(result.value.CHANNEL_CONTRACT, undefined);
  assert.equal(result.value.BACKEND_EVENTS_URL, undefined);
});
