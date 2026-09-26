// POST /citrus/webhooks (docs/citrus-mobile-spec.md v2 §7 R10): mounted ONLY
// when CONNECTIVITY_PROVIDER=citrus and CITRUS_WEBHOOK_SECRET is set. The body
// parser is `express.raw({ type: "application/json" })` registered BEFORE the
// app-wide `express.json()`, so this route always sees the RAW body for the
// HMAC verification and the rest of the app is unaffected (R10: "sin afectar
// otras rutas").
//
// Handshake: invalid signature -> 401; otherwise 200 regardless of what the
// handler did with the event (R10 answers 200 even for unknown event types —
// only a malformed/undedupable event is logged and still 200'd, so Citrus
// never redelivers valid traffic forever).

import type { Request, Response } from "express";
import type { CitrusWebhookHandler } from "../../services/CitrusWebhookHandler.ts";
import { verifyCitrusSignature } from "../../services/CitrusWebhookHandler.ts";

export type CitrusWebhooksRouteOptions = {
  handler: CitrusWebhookHandler;
  secret: string;
};

export function createCitrusWebhooksRoute(options: CitrusWebhooksRouteOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const signature = req.get("x-citrus-signature");
    if (!verifyCitrusSignature(body, signature, options.secret)) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      payload = null;
    }

    try {
      const result = await options.handler.handle(payload);
      // `handle` only answers `invalid_signature` when the caller skipped its
      // own verification — this route already verified the raw body above, so
      // the branch is unreachable in practice but kept typed and explicit.
      if (!result.accepted) {
        res.status(401).json({ error: "invalid_signature" });
        return;
      }
      res.status(200).json({ received: true, handled: result.handled });
    } catch (error) {
      // The handler itself is meant to never throw (R10: persist-then-200);
      // this is a last-resort safety net so a processing bug is a 200 + a log
      // line, never a 500 that redelivers the event forever.
      res.status(200).json({ received: true, handled: "processor_error" });
      process.stderr.write(
        `${JSON.stringify({ level: "error", reason: "webhook_route_failed", detail: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  };
}