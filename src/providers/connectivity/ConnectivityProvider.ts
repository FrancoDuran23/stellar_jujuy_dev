// Connectivity provider seam (connectivity layer, "escalón conectividad").
// One interface, several possible backends (Telnyx today, a simulator for
// tests/demo, a fake for dry-runs). Mirrors the repo's port pattern: business
// code (PolicyEnforcer, reconciliation) depends on this interface, never on
// TelnyxProvider directly.
//
// Unit contract shared by every implementation:
// - amount/units are returned EXACTLY as the provider reports them
//   (`getUsage` returns MB, never bytes — the conversion to bytes lives in
//   `src/jobs/reconciliation.ts`, explicitly, so it can never be mistaken for
//   billing data);
// - purchasing is one-shot: it registers an eSIM (id + iccid) AND yields the
//   activation code the user scans.

export type EsimRecord = {
  /** Telnyx `id` — the account-level key that identifies this SIM (UUID). */
  simCardId: string;
  /** ICCID of the chip, for reconciliation and support (offline id). */
  iccid: string;
  /** One-time LPA code / QR content the user scans to install the profile. */
  activationCode: string;
};

export type SimUsage = {
  /** Reported consumption, in MB (provider units — NOT bytes). */
  mb: number;
  /** Provider lifecycle status string (e.g. "enabled", "disabled"). */
  status: string;
};

/** The seam `PolicyEnforcer` and `reconciliation` consume. */
export interface ConnectivityProvider {
  /** Provisions the eSIM for a user session and returns its activation code. */
  purchaseEsim(userId: string): Promise<EsimRecord>;
  /** Enables a SIM for consumption. Async operation; resolves when done. */
  enable(simCardId: string): Promise<void>;
  /** Disables a SIM (data cutoff). Async operation; resolves when done. */
  disable(simCardId: string): Promise<void>;
  /** Caps how much data the SIM may still use, in MB (`unit: MB`). */
  setDataLimit(simCardId: string, mb: number): Promise<void>;
  /** Reads reported consumption (MB) + lifecycle status. No unit conversion. */
  getUsage(simCardId: string): Promise<SimUsage>;
}