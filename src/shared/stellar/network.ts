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
