// Connectivity provider seam (connectivity layer, "escalón conectividad").
// One interface, several possible backends (Citrus today, a fake for
// tests/demos, a dry-run fake). Mirrors the repo's port pattern: business
// code (PolicyEnforcer, meter, FundingService, SessionCloser) depends on this
// interface, never on a provider directly.
//
// Unit contract shared by every implementation (docs/citrus-mobile-spec.md v2):
// - money is bigint micro-USD here, never a `number` dollar amount: the ONLY
//   USD → micro conversion happens inside the real provider (CitrusProvider);
// - `getUsage` reports the eSIM's LIFETIME charged consumption (`chargedMicroUsd`)
//   plus the prepaid wallet's remaining balance (`walletMicroUsd`) — bytes are
//   never reported here; the trip baseline and the equivalent-bytes conversion
//   live in `src/persistence/esim-record.ts` and `src/shared/usage-math.ts`;
// - provisioning is idempotent per user (R4): it registers the eSIM AND yields
//   the install payload (LPA/QR) the user scans.

export type EsimRecord = {
  /** ICCID of the chip — the account-level key that identifies this eSIM. */
  iccid: string;
  /** SM-DP+ + activation code, scanned as QR to install the profile. */
  lpaString: string;
  /** QR code as PNG data URL. */
  qrCode: string;
  /** iOS 17.4+ one-tap install URL. */
  directInstallUrl: string;
  /** Provider lifecycle status (e.g. "active", "suspended", "terminated"). */
  status: string;
};

export type SimUsage = {
  /** LIFETIME charged consumption, micro-USD (NOT per trip — U2). The trip
   *  consumes `chargedMicroUsd − baseline`, where baseline is the value read
   *  right before the trip's first top-up (persisted in esim-record). */
  chargedMicroUsd: bigint;
  /** Remaining prepaid wallet, micro-USD. 0 → the provider already cut data. */
  walletMicroUsd: bigint;
  /** Provider lifecycle status string (e.g. "active", "suspended"). */
  status: string;
  /** Provider read timestamp, ISO. */
  asOf: string;
};

/** The seam business code consumes. */
export interface ConnectivityProvider {
  /** Provisions the eSIM for a user trip (idempotent per userRef, R4) and
   *  returns its install payload. `label` is optional human metadata. */
  provisionEsim(userRef: string, label?: string): Promise<EsimRecord>;
  /** Funds the eSIM wallet by `amountCents` (integer USD cents). */
  topUp(iccid: string, amountCents: number): Promise<void>;
  /** Reads consumption (lifetime charged micro-USD) + wallet + status. */
  getUsage(iccid: string): Promise<SimUsage>;
  /** Pauses data (suspend). Async; resolves when done. */
  suspend(iccid: string): Promise<void>;
  /** Resumes data. Async; resolves when done. */
  resume(iccid: string): Promise<void>;
  /** Requests the wallet refund (defund). Idempotent (202). */
  refundUnused(iccid: string): Promise<void>;
  /** Permanently deletes the eSIM (requires an already-empty wallet). */
  terminate(iccid: string): Promise<void>;
}