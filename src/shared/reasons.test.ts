import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentError, REASONS, isReason, retryableFor, statusFor } from "./reasons.ts";
import { EVENT_TYPES, emit } from "./events.ts";

test("every reason maps to exactly 200 or 503 (FT-R5)", () => {
  for (const [reason, mapping] of Object.entries(REASONS)) {
    assert.ok(
      mapping.status === 200 || mapping.status === 503,
      `${reason} has an invalid status ${mapping.status}`,
    );
  }
});

test("every 503 reason is retryable and every 200 reason is not (FT-R6)", () => {
  for (const [reason, mapping] of Object.entries(REASONS)) {
    if (mapping.status === 503) {
      assert.equal(mapping.retryable, true, `${reason} is 503 but not retryable`);
    } else {
      assert.equal(mapping.retryable, false, `${reason} is 200 but marked retryable`);
    }
  }
});

test("FT-R6 exact mapping table", () => {
  const expected: Record<string, { retryable: boolean; status: 200 | 503 }> = {
    channel_exhausted: { retryable: false, status: 200 },
    channel_closing: { retryable: false, status: 200 },
    channel_not_found: { retryable: false, status: 200 },
    channel_not_open: { retryable: false, status: 200 },
    stale_reading: { retryable: false, status: 200 },
    amount_rejected: { retryable: false, status: 200 },
    signer_unavailable: { retryable: true, status: 503 },
    upstream_unavailable: { retryable: true, status: 503 },
    internal_error: { retryable: true, status: 503 },
  };
  assert.deepEqual(REASONS, expected);
});

test("isReason narrows unknown strings", () => {
  assert.equal(isReason("channel_exhausted"), true);
  assert.equal(isReason("made_up_reason"), false);
  assert.equal(isReason(42), false);
});

test("retryableFor and statusFor read straight from REASONS", () => {
  assert.equal(retryableFor("upstream_unavailable"), true);
  assert.equal(statusFor("upstream_unavailable"), 503);
  assert.equal(retryableFor("stale_reading"), false);
  assert.equal(statusFor("stale_reading"), 200);
});

test("PaymentError carries its reason and detail, never a bare Error", () => {
  const error = new PaymentError("amount_rejected", "expected 125000, received 100000");
  assert.equal(error.reason, "amount_rejected");
  assert.equal(error.detail, "expected 125000, received 100000");
  assert.ok(error instanceof Error);
});

test("emit() writes exactly one valid JSON line to stdout (EV-R1, EV-R2)", () => {
  const lines: string[] = [];
  const envelope = emit(
    { type: "usage.voucher_signed", sessionId: "sess_1", data: { cumulativeAmount: "125000" } },
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith("\n"));
  const parsed = JSON.parse(lines[0]!);
  assert.deepEqual(parsed, envelope);
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.id, "string");
  assert.equal(typeof parsed.occurredAt, "string");
  assert.equal(parsed.type, "usage.voucher_signed");
  assert.equal(parsed.sessionId, "sess_1");
  assert.equal(parsed.userId, null);
  assert.deepEqual(parsed.data, { cumulativeAmount: "125000" });
});

test("emit() defaults sessionId and userId to null when omitted", () => {
  const lines: string[] = [];
  emit({ type: "channel.exhausted", data: {} }, (line) => lines.push(line));
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.sessionId, null);
  assert.equal(parsed.userId, null);
});

test("every event type required by EV-R3 is a valid EventType", () => {
  const required = [
    "charge.settled",
    "channel.opened",
    "channel.topped_up",
    "usage.voucher_signed",
    "channel.exhausted",
    "channel.closed",
    "payment.failed",
  ];
  for (const type of required) {
    assert.ok((EVENT_TYPES as readonly string[]).includes(type), `${type} missing from EVENT_TYPES`);
  }
});
