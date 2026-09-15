// Format-only validators for Stellar/Soroban identifiers (design 4.4, table
// 3.9). These check shape (length + strkey prefix, or hex length) — they
// never touch the network and never parse a real Keypair. Actual Keypair
// parsing happens in `config/env.ts` (T3.1), which imports the SDK; this
// module stays SDK-free so `shared/` can be imported everywhere without
// pulling in @stellar/stellar-sdk transitively.

// Stellar strkey body: 55 base32 (RFC 4648, no padding) chars after a
// 1-char version prefix, 56 chars total.
const STRKEY_BODY = "[A-Z2-7]{55}";

const ACCOUNT_ID_RE = new RegExp(`^G${STRKEY_BODY}$`);
const CONTRACT_ID_RE = new RegExp(`^C${STRKEY_BODY}$`);
const SECRET_SEED_RE = new RegExp(`^S${STRKEY_BODY}$`);

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const HEX_128_RE = /^[0-9a-fA-F]{128}$/;

/** `G...`, 56 chars: a Stellar account id (e.g. STELLAR_RECIPIENT, FUNDER_ACCOUNT). */
export function isStellarAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_RE.test(value);
}

/** `C...`, 56 chars: a Soroban contract id (e.g. CHANNEL_CONTRACT, USDC_SAC_CONTRACT). */
export function isStellarContractId(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_ID_RE.test(value);
}

/** `S...`, 56 chars: a Stellar secret seed (e.g. FEE_PAYER_SECRET, SIGNER_SECRET). */
export function isStellarSecretSeed(value: unknown): value is string {
  return typeof value === "string" && SECRET_SEED_RE.test(value);
}

/** 64 lowercase/uppercase hex chars: an ed25519 public key or COMMITMENT_SECRET. */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64_RE.test(value);
}

/** 128 hex chars: an ed25519 signature. */
export function isHex128(value: unknown): value is string {
  return typeof value === "string" && HEX_128_RE.test(value);
}
