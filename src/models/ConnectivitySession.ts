// ConnectivitySession record (connectivity layer). One record per user trip:
// the seam that ties the Citrus eSIM (iccid — the account-level key) to the
// Stellar channel (channelId) and to the micro-USD ledger the product cares
// about.
//
// Money bookkeeping (docs/citrus-mobile-spec.md v2 §7 R13, U2):
// - `chargedMicroUsd` is the LIFETIME charged figure from `getUsage()` — the
//   provider accumulates across trips (never per trip);
// - `chargedBaselineMicroUsd` is the charged figure read when the trip
//   started; `chargedMicroUsd − chargedBaselineMicroUsd` is what THIS trip
//   consumed;
// - `fundedMicroUsd` is what the prepaid wallet received this trip (I2).
// All bigint micro-USD, never floats.

export type ConnectivityProviderName = "citrus";

export type ConnectivitySession = {
  id: string;
  userId: string;
  provider: ConnectivityProviderName;
  /** Citrus eSIM — the iccid is the account-level key. */
  iccid: string;
  /** Stellar one-way channel this session spends against. */
  channelId: string;
  /** Lifetime charged read, micro-USD (provider accumulation, U2). */
  chargedMicroUsd: bigint;
  /** Charged at trip start, micro-USD — the trip's discount (R13). */
  chargedBaselineMicroUsd: bigint;
  /** Prepaid wallet funded this trip, micro-USD (I2). */
  fundedMicroUsd: bigint;
  startedAt: string;
  endedAt: string | null;
};

/** Creates a zeroed session for a new trip. `provider` is fixed to the only
 * wired backend, so callers can't accidentally mix providers later. */
export function createConnectivitySession(input: {
  id: string;
  userId: string;
  iccid: string;
  channelId: string;
  startedAt?: string;
}): ConnectivitySession {
  return {
    id: input.id,
    userId: input.userId,
    provider: "citrus",
    iccid: input.iccid,
    channelId: input.channelId,
    chargedMicroUsd: 0n,
    chargedBaselineMicroUsd: 0n,
    fundedMicroUsd: 0n,
    startedAt: input.startedAt ?? new Date().toISOString(),
    endedAt: null,
  };
}