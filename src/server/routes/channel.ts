// `POST /channel/vouchers` (design 4.2's "agent -> server" hop). Internal
// only — the gateway never sees this route (design 4.1: "El salto agent ->
// server es interno e invisible para el gateway"). No separate bearer auth:
// the ed25519 commitment signature itself IS the credential (the same
// security model `@stellar/mpp`'s own channel Method uses — a request
// carries no proof beyond a signature that verifies against
// `COMMITMENT_PUBKEY`), and forging one requires `COMMITMENT_SECRET`. This
// mirrors FT-R5's own principle applied to an internal hop: business
// outcomes are never expressed as 4xx, so every well-formed, schema-valid
// request gets a `200` with an explicit `accepted` flag.

import type { RequestHandler } from "express";
import { z } from "zod";
import type { ChannelService } from "../channel-service.ts";

const channelVoucherBodySchema = z.object({
  channel: z.string().min(1),
  network: z.string().min(1),
  cumulativeAmount: z.string().regex(/^\d+$/),
  signature: z.string().regex(/^[0-9a-fA-F]{128}$/),
  commitmentPubkey: z.string().regex(/^[0-9a-fA-F]{64}$/),
  sessionId: z.string().min(1),
  cumulativeBytes: z.number().int().nonnegative(),
  meterReadingId: z.string().min(1),
});

export type CreateChannelRouteDeps = {
  channelService: ChannelService;
};

/** `POST /channel/vouchers`: verifies + persists a commitment. Always `200`
 * for a schema-valid, business-level outcome (`{accepted, ...}` or
 * `{accepted:false, reason, detail}`); `400` only for a malformed body. */
export function createChannelVouchersRoute(deps: CreateChannelRouteDeps): RequestHandler {
  return async (req, res) => {
    const parsed = channelVoucherBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid channel voucher body", issues: parsed.error.issues });
      return;
    }
    const outcome = await deps.channelService.verifyAndAccept({
      channel: parsed.data.channel,
      network: parsed.data.network,
      cumulativeAmountRaw: BigInt(parsed.data.cumulativeAmount),
      signatureHex: parsed.data.signature,
      commitmentPubkey: parsed.data.commitmentPubkey,
      sessionId: parsed.data.sessionId,
      cumulativeBytes: parsed.data.cumulativeBytes,
      meterReadingId: parsed.data.meterReadingId,
    });
    if (outcome.kind === "accepted") {
      res.status(200).json({ accepted: true, remaining: outcome.remainingRaw.toString() });
      return;
    }
    res.status(200).json({ accepted: false, reason: outcome.reason, detail: outcome.detail });
  };
}
