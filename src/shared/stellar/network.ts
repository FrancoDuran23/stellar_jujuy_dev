// Network identifiers and passphrases (design 4.4). `shared/` is the only
// module that knows what a "network" string means; nothing else hardcodes a
// passphrase.

export const NETWORKS = ["stellar:testnet", "stellar:pubnet"] as const;

export type Network = (typeof NETWORKS)[number];

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

const NETWORK_PASSPHRASES: Record<Network, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

export function networkPassphrase(network: Network): string {
  return NETWORK_PASSPHRASES[network];
}

/**
 * Sanitizes a network id for use inside a filename (WU6/WU7 Windows gotcha,
 * docs/sdd/payments-mpp.md §6, Lote E): `network` values contain a literal
 * `:` (`"stellar:testnet"`), which NTFS treats as an Alternate-Data-Stream
 * separator. `fs.openSync(path, "a")` on such a path silently succeeds
 * against a stream on a truncated base file (e.g. `vouchers-agent-stellar`
 * instead of `vouchers-agent-stellar:testnet.jsonl`) — round-trips fine
 * through Node's own fs calls, so nothing throws, but `fs.renameSync`
 * (`persistence/cursor.ts`, `persistence/channel-record.ts`) rejects the
 * same path outright with `EINVAL`. New WU6/WU7 file paths use this helper;
 * the pre-existing `VoucherLog` naming is untouched (out of scope here) but
 * documented as the same latent quirk.
 */
export function sanitizeNetworkForFilename(network: string): string {
  return network.replace(/:/g, "-");
}
