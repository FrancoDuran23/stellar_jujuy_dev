import { test } from "node:test";
import assert from "node:assert/strict";
import { unsignedResponse } from "./http.ts";
import { message2UnsignedSchema } from "./messages.ts";

test("unsignedResponse maps a 200 reason with no Retry-After header", async () => {
  const response = unsignedResponse("channel_exhausted", {
    sessionId: "sess_1",
    meterReadingId: "mr_1",
    detail: "deposit exhausted",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("retry-after"), null);
  const body = message2UnsignedSchema.parse(await response.json());
  assert.equal(body.status, "unsigned");
  assert.equal(body.reason, "channel_exhausted");
  assert.equal(body.retryable, false);
});

test("unsignedResponse maps a 503 reason with Retry-After: 5 (FC-R5)", async () => {
  const response = unsignedResponse("upstream_unavailable", {
    sessionId: null,
    meterReadingId: null,
    detail: "Soroban RPC unreachable",
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = message2UnsignedSchema.parse(await response.json());
  assert.equal(body.retryable, true);
  assert.equal(body.sessionId, null);
  assert.equal(body.meterReadingId, null);
});

test("unsignedResponse content-type is application/json", () => {
  const response = unsignedResponse("internal_error", {
    sessionId: null,
    meterReadingId: null,
    detail: "unexpected error",
  });
  assert.equal(response.headers.get("content-type"), "application/json");
});
