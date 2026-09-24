// Fetch API `Response` helpers shared by the server's `requireReady`
// middleware (T4.1) and route handlers (T3.2). Centralizes "M2 unsigned
// envelope -> HTTP Response" so every fail-closed and failure path produces
// the exact same status/header shape (FC-R5, FT-R2: a 503 always carries
// `Retry-After`; `buildUnsigned` already ties `retryable`/status to
// `REASONS`, so this module cannot pick a status that disagrees with them).

import { buildUnsigned } from "./messages.ts";
import type { Reason } from "./reasons.ts";

const RETRY_AFTER_SECONDS = 5;

/** Builds the HTTP response for an unsigned M2 envelope (FC-R5, FT-R2). */
export function unsignedResponse(
  reason: Reason,
  fields: Parameters<typeof buildUnsigned>[1],
): Response {
  const { body, status } = buildUnsigned(reason, fields);
  const headers = new Headers({ "content-type": "application/json" });
  if (status === 503) {
    headers.set("retry-after", String(RETRY_AFTER_SECONDS));
  }
  return new Response(JSON.stringify(body), { status, headers });
}
