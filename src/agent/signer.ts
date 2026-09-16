// Commitment signer port (design 4.1's testability rule; T5.3 deviation,
// Lote C). The real signer — ed25519 over the XDR map `{amount, channel,
// domain "chancmmt", network}` using `COMMITMENT_SECRET` (design 4.3) — is
// stage 2 / WU6 work: it needs a real channel contract to make sense of, and
// touches the Stellar SDK, which design 4.1 confines to `config/boot.ts`.
// `POST /vouchers` (T5.3, "escalón 1.5") needs *a* signer today to be
// end-to-end testable, so this module defines the port now and a
// deterministic fake behind it; `config/boot.ts` swaps in the real
// SDK-backed implementation once WU6 lands, without `agent/routes/
// vouchers.ts` changing at all.

import { createHash } from "node:crypto";

export type SignInput = {
  channel: string;
  network: string;
  /** Raw i128 units, as a digit string (never a bigint or number — AC-R5). */
  cumulativeAmount: string;
  /**
   * Correlation-only context (WU7) — never part of the signed bytes, never
   * used for idempotency (design 4.3: that is `cumulativeAmount` alone).
   * The real, stage-2 signer (`config/boot.ts`'s `createServerDeliveringSigner`)
   * forwards these to the payment server's `POST /channel/vouchers` so its
   * own JSONL record carries the same session/meter correlation as the
   * agent's; `createFakeSigner` ignores them entirely.
   */
  sessionId: string;
  cumulativeBytes: number;
  meterReadingId: string;
};

export type SignResult = {
  /** 128 hex chars. */
  signature: string;
  /** 64 hex chars. */
  commitmentPubkey: string;
};

export type SignerPort = {
  sign(input: SignInput): Promise<SignResult>;
};

/**
 * Deterministic stand-in for the real ed25519 signer (design 4.2 relies on
 * ed25519 determinism — RFC 8032 — for idempotent re-signs; this fake
 * preserves that property so `POST /vouchers`'s idempotency/coalescing
 * behaviour is exercised faithfully even without a real key). NEVER used
 * once a real `COMMITMENT_SECRET`-backed signer exists (WU6) — `seed` is a
 * label for test fixtures and demo runs, not a secret.
 */
export function createFakeSigner(seed = "stage1.5-fake-signer"): SignerPort {
  // Fixed per signer instance, exactly like a real commitment keypair's
  // public half never changes across signatures.
  const commitmentPubkey = createHash("sha256").update(`${seed}:commitment-pubkey`).digest("hex");

  return {
    async sign(input) {
      const signature = createHash("sha512")
        .update(`${seed}:${input.network}:${input.channel}:${input.cumulativeAmount}`)
        .digest("hex");
      return { signature, commitmentPubkey };
    },
  };
}
