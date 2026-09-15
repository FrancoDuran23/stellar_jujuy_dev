// USDC trustline check contract (design 4.1 testability rule; used later by
// CL-R9 before `close`, CL-R12 at boot, and the preflight script). The real
// implementation reads the account's trustlines via Soroban RPC and is
// wired in `config/boot.ts` (a later work unit) — `shared/` stays SDK-free,
// so the port is the only thing defined here.

export type TrustlinePort = {
  hasUsdcTrustline(accountId: string): Promise<boolean>;
};

/** Human-readable alarm detail for a missing trustline (CL-R9, FC-R3-adjacent alarms). */
export function describeMissingTrustline(accountId: string, asset = "USDC"): string {
  return `account ${accountId} does not hold a ${asset} trustline`;
}
