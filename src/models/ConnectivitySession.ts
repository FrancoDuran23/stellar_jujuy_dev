// ConnectivitySession record (connectivity layer). One record per user trip:
// the seam that ties the Telnyx SIM (simCardId/iccid) to the Stellar channel
// (channelId) and to the two byte counters the product cares about.
//
// Bytes bookkeeping:
// - `meteredBytes` is the gateway's own measurement — THE billing source of
//   truth (docs/telnyx-wireless-integracion.md §1). Never sourced from Telnyx.
// - `carrierBytes` is the Telnyx-reported usage converted to bytes, for
//   reconciliation only (src/jobs/reconciliation.ts). bigint, never float.

export type ConnectivityProviderName = "telnyx";

export type ConnectivitySession = {
  id: string;
  userId: string;
  provider: ConnectivityProviderName;
  simCardId: string;
  iccid: string;
  /** Stellar one-way channel this session spends against. */
  channelId: string;
  /** Gateway-measured bytes — facturación. */
  meteredBytes: bigint;
  /** Telnyx-reported bytes — reconciliación únicamente. */
  carrierBytes: bigint;
  startedAt: string;
  endedAt: string | null;
};

/** Creates a session with both counters zeroed. `provider` is fixed to the
 * only wired backend, so callers can't accidentally mix providers later. */
export function createConnectivitySession(input: {
  id: string;
  userId: string;
  simCardId: string;
  iccid: string;
  channelId: string;
  startedAt?: string;
}): ConnectivitySession {
  return {
    id: input.id,
    userId: input.userId,
    provider: "telnyx",
    simCardId: input.simCardId,
    iccid: input.iccid,
    channelId: input.channelId,
    meteredBytes: 0n,
    carrierBytes: 0n,
    startedAt: input.startedAt ?? new Date().toISOString(),
    endedAt: null,
  };
}