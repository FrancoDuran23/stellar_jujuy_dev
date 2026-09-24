// Stage 1 headless purchase client (design 4.1, 4.2; spec S1-R2, S1-R3,
// T3.3). This is one of the two places the design's testability rule (4.1)
// allows the Stellar/mppx SDK to be instantiated directly, alongside
// `config/boot.ts` — it is not one of the excluded service files
// (charge-service.ts, channel-service.ts, close-monitor.ts, signer.ts).
//
// `polyfill: false` is passed to `Mppx.create()` deliberately: the client
// SDK's default behavior mutates `globalThis.fetch` process-wide (confirmed
// against the installed `mppx` source), which would make this module unsafe
// to import anywhere that also makes unrelated fetch calls — including this
// very test suite. `mppx.fetch` is used explicitly instead: it has the exact
// same automatic 402-handling behavior, scoped to this one client instance.

import { Keypair } from "@stellar/stellar-sdk";
import { Mppx, stellar } from "@stellar/mpp/charge/client";
import { message2UnsignedSchema } from "../shared/messages.ts";
import type { Reason } from "../shared/reasons.ts";

export type ChargeReceipt = {
  txHash: string;
  explorerUrl: string;
  network: string;
  payload: unknown;
};

type ServerChargeResponseBody = {
  payload: unknown;
  payment?: { txHash?: unknown; explorerUrl?: unknown; network?: unknown };
};

/**
 * `purchase()`'s result (T8.2 open finding #1): a `GET /paid-resource` `200`
 * does not always carry a settled payment — the server also answers `200`
 * (or `503`) with a plain M2 unsigned envelope (`shared/messages.ts`) for a
 * clean business outcome such as `stale_reading` (FT-R6) or a retryable
 * `signer_unavailable`/`upstream_unavailable`. Both are typed outcomes here,
 * never a thrown error — only a malformed body or a technical/network
 * failure throws (see `createMppChargeClient`).
 */
export type PurchaseOutcome =
  | { kind: "settled"; receipt: ChargeReceipt }
  | {
      kind: "unsigned";
      reason: Reason;
      retryable: boolean;
      detail: string;
      /** From the `Retry-After` response header, when present (FT-R2 ties it
       * to a `503`); `null` otherwise. */
      retryAfterSeconds: number | null;
    };

/**
 * The only boundary between the CLI (`agent/main.ts`) and the SDK. A fake in
 * tests never touches the network, and — since the agent only ever signs
 * Soroban authorization entries in sponsored mode (S1-R2) and never builds
 * or submits a transaction itself — never touches the agent's XLM balance
 * either (S1-R3): there is nothing balance-related for a fake to simulate.
 */
export type ChargeClientPort = {
  /** Performs exactly one paid GET request against `url` and returns either
   * the settlement receipt or a typed M2 unsigned outcome. Throws only for a
   * malformed response body or a technical/network failure. */
  purchase(url: string): Promise<PurchaseOutcome>;
};

function parseRetryAfterSeconds(header: string | null): number | null {
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Pure response-parsing core of `purchase()`, split out so the T8.2 open
 * finding (a `200`/`503` that carries an M2 unsigned envelope instead of a
 * settled payment) is unit-testable without constructing the real SDK client
 * or a network `Response` (design 4.1's testability rule — only
 * `createMppChargeClient` itself touches `mppx`). Throws only for a
 * malformed body or an HTTP failure with no usable M2 envelope.
 */
export function parsePurchaseResult(
  status: number,
  retryAfterHeader: string | null,
  body: unknown,
): PurchaseOutcome {
  // Checked before the HTTP status: a `503` unsigned envelope (retryable
  // `signer_unavailable`/`upstream_unavailable`/`internal_error`) is a clean
  // business outcome, not a technical failure — it must not throw.
  const unsigned = message2UnsignedSchema.safeParse(body);
  if (unsigned.success) {
    return {
      kind: "unsigned",
      reason: unsigned.data.reason,
      retryable: unsigned.data.retryable,
      detail: unsigned.data.detail,
      retryAfterSeconds: parseRetryAfterSeconds(retryAfterHeader),
    };
  }

  if (status < 200 || status >= 300) {
    throw new Error(`stage 1 purchase failed: HTTP ${status} — ${JSON.stringify(body)}`);
  }

  const parsedBody = body as ServerChargeResponseBody;
  const txHash = parsedBody.payment?.txHash;
  const explorerUrl = parsedBody.payment?.explorerUrl;
  const network = parsedBody.payment?.network;
  if (typeof txHash !== "string" || typeof explorerUrl !== "string" || typeof network !== "string") {
    throw new Error("stage 1 purchase response is missing payment.txHash/explorerUrl/network");
  }
  return {
    kind: "settled",
    receipt: { txHash, explorerUrl, network, payload: parsedBody.payload },
  };
}

/**
 * Builds the real, SDK-backed `ChargeClientPort`. `signerSecret` (S..., 56
 * chars) signs Soroban authorization entries only — the server rebuilds,
 * signs the envelope, and pays the fee as the sponsored transaction's source
 * (S1-R2, S1-R3); this module never constructs or submits a transaction.
 */
export function createMppChargeClient(signerSecret: string): ChargeClientPort {
  const mppx = Mppx.create({
    polyfill: false,
    methods: [stellar.charge({ keypair: Keypair.fromSecret(signerSecret) })],
  });

  return {
    async purchase(url) {
      const response = await mppx.fetch(url);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(
          `stage 1 purchase response is not valid JSON (HTTP ${response.status})`,
        );
      }

      return parsePurchaseResult(response.status, response.headers.get("retry-after"), body);
    },
  };
}

/**
 * Thin, testable wrapper around a single one-shot purchase — the piece
 * `agent/main.ts` (the headless CLI, T8.2) actually calls. Kept separate
 * from `createMppChargeClient` so a fake `ChargeClientPort` can exercise the
 * "one paid request" flow without ever constructing the real SDK client.
 */
export async function runOneShotPurchase(
  port: ChargeClientPort,
  url: string,
): Promise<PurchaseOutcome> {
  return port.purchase(url);
}
