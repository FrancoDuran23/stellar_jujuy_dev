// USDC trustline check contract (design 4.1 testability rule; used later by
// CL-R9 before `close`, CL-R12 at boot, and the preflight script). The real
// implementation reads the account's trustlines via Soroban RPC and is
// wired in `config/boot.ts` (a later work unit) — `shared/` stays SDK-free,
// so the port is the only thing defined here.
//
// Tri-state result (review finding 3, Lote F): a plain boolean could not
// distinguish "the trustline is genuinely missing" from "we could not tell
// because Horizon errored" — the pre-fix `createHorizonTrustlinePort`
// collapsed both into `false`, which made `close-monitor.ts`/
// `channel-service.ts` block a close over a transient Horizon hiccup exactly
// when a dispute needed it most. `"unknown"` lets the caller fail OPEN
// (proceed with the close, WARN) instead of fail closed on a diagnosis
// failure, matching this codebase's FC-R1 philosophy elsewhere.
export type TrustlineStatus = "yes" | "no" | "unknown";

export type TrustlinePort = {
  hasUsdcTrustline(accountId: string): Promise<TrustlineStatus>;
};

/** Human-readable alarm detail for a missing trustline (CL-R9, FC-R3-adjacent alarms). */
export function describeMissingTrustline(accountId: string, asset = "USDC"): string {
  return `account ${accountId} does not hold a ${asset} trustline`;
}
