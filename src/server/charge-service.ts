// Stage 1 charge orchestration (design 4.1, 4.2; spec S1-R1..S1-R6, T3.2).
// The Stellar/mppx SDK is never touched here — only through the `ChargePort`
// boundary, per the design's testability rule (4.1: the SDK is instantiated
// *only* in `config/boot.ts`). This module is fully testable with a fake
// port and never makes a network call.

import { emit as defaultEmit, type EmitInput } from "../shared/events.ts";
import { unsignedResponse } from "../shared/http.ts";
import type { Reason } from "../shared/reasons.ts";
import { buildExplorerUrl } from "../shared/stellar/explorer.ts";

export type ChargeOutcome =
  | { kind: "challenge"; response: Response }
  | { kind: "settled"; txHash: string; buildResponse: (body: unknown) => Response }
  | { kind: "failed"; reason: Reason; detail: string };

/**
 * The only boundary between this module and the Stellar/mppx SDK. The real
 * implementation (built in `config/boot.ts`, T4.1) wraps `Mppx.create(...)`
 * from `@stellar/mpp/charge/server` and a correlated `receipt.reference` as
 * the settled `txHash` (Spike S3 finding — see `config/boot.ts` for how the
 * receipt is captured). Tests pass a fake that returns a canned outcome.
 */
export type ChargePort = {
  handle(
    request: Request,
    params: { amountRaw: string; description?: string },
  ): Promise<ChargeOutcome>;
};

export type ChargeServiceDeps = {
  chargePort: ChargePort;
  network: string;
  explorerBaseUrl: string;
  emit?: (input: EmitInput) => void;
};

export type ChargeParams = {
  sessionId: string | null;
  amountRaw: string;
  description?: string;
};

export type ChargeResult = {
  response: Response;
  /**
   * True only when this call actually settled a payment on-chain. Callers
   * (the route handler) use this — never the HTTP status — to decide whether
   * to advance any of their own session bookkeeping: several `failed`
   * reasons also map to HTTP 200 (FT-R6), so status alone cannot
   * distinguish "settled" from "cleanly rejected".
   */
  settled: boolean;
};

/**
 * Builds the stage 1 charge handler. Three outcomes, matching S1-R1/S1-R4/
 * S1-R6 exactly:
 *
 * - `challenge`: no credential attached — the 402 challenge is passed
 *   through unchanged; no on-chain transaction is ever emitted for this
 *   branch (S1-R1).
 * - `settled`: the port already verified and broadcast the payment. This is
 *   the only place `payment.txHash`/`explorerUrl`/`network` are added to the
 *   response body and the only place `charge.settled` is emitted (S1-R4).
 * - `failed`: the charge could not be completed. Always an M2 unsigned
 *   envelope with an explicit `retryable` (S1-R6), and always
 *   `payment.failed` too, so a failure is as observable as a settlement.
 */
export function createChargeService(
  deps: ChargeServiceDeps,
): (request: Request, params: ChargeParams) => Promise<ChargeResult> {
  const emitEvent = deps.emit ?? defaultEmit;

  return async function handleCharge(request, params) {
    const outcome = await deps.chargePort.handle(request, {
      amountRaw: params.amountRaw,
      description: params.description,
    });

    if (outcome.kind === "challenge") {
      return { response: outcome.response, settled: false };
    }

    if (outcome.kind === "settled") {
      const explorerUrl = buildExplorerUrl(deps.explorerBaseUrl, outcome.txHash);
      emitEvent({
        type: "charge.settled",
        sessionId: params.sessionId,
        data: {
          amountRaw: params.amountRaw,
          txHash: outcome.txHash,
          explorerUrl,
          network: deps.network,
        },
      });
      const response = outcome.buildResponse({
        payload: { message: "payment settled" },
        payment: { txHash: outcome.txHash, explorerUrl, network: deps.network },
      });
      return { response, settled: true };
    }

    emitEvent({
      type: "payment.failed",
      sessionId: params.sessionId,
      data: { reason: outcome.reason, detail: outcome.detail },
    });
    const response = unsignedResponse(outcome.reason, {
      sessionId: params.sessionId,
      meterReadingId: null,
      detail: outcome.detail,
    });
    return { response, settled: false };
  };
}
