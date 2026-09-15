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
 * The only boundary between the CLI (`agent/main.ts`) and the SDK. A fake in
 * tests never touches the network, and — since the agent only ever signs
 * Soroban authorization entries in sponsored mode (S1-R2) and never builds
 * or submits a transaction itself — never touches the agent's XLM balance
 * either (S1-R3): there is nothing balance-related for a fake to simulate.
 */
export type ChargeClientPort = {
  /** Performs exactly one paid GET request against `url` and returns the settlement receipt. */
  purchase(url: string): Promise<ChargeReceipt>;
};

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
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`stage 1 purchase failed: HTTP ${response.status} — ${detail}`);
      }
      const body = (await response.json()) as ServerChargeResponseBody;
      const txHash = body.payment?.txHash;
      const explorerUrl = body.payment?.explorerUrl;
      const network = body.payment?.network;
      if (typeof txHash !== "string" || typeof explorerUrl !== "string" || typeof network !== "string") {
        throw new Error("stage 1 purchase response is missing payment.txHash/explorerUrl/network");
      }
      return { txHash, explorerUrl, network, payload: body.payload };
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
): Promise<ChargeReceipt> {
  return port.purchase(url);
}
