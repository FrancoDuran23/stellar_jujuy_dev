// Contract-backed deposit + lifecycle cache (design 4.2's "el agent corta
// primero con depositedRaw cacheado", CL-R4; T6.3). SDK-free — wraps a
// `ChannelRpcPort` (built with the real Stellar SDK in `config/boot.ts`)
// behind a short TTL cache so `POST /vouchers` never pays a fresh RPC round
// trip per request while still noticing a top-up or a close_start within one
// TTL window. Fully testable with a fake `ChannelRpcPort`.

import type { ChannelInfo } from "./routes/vouchers.ts";

export type ContractChannelInfo =
  | { found: true; depositRaw: bigint; closing: boolean }
  | { found: false };

/** The one seam between this module and the real contract (built with
 * `@stellar/stellar-sdk` in `config/boot.ts` on top of `shared/stellar/
 * channel-contract.ts`). Never throws for a routine "channel closing" or
 * "channel not found" outcome — those are `found`/`closing` values, not
 * exceptions. May still reject for a genuine transport failure (RPC down);
 * the cache below maps that to `channel_not_found`-safe behavior by simply
 * not swallowing it — the caller (`agent/routes/vouchers.ts`, via
 * `withTimeout`) already turns a rejection into `upstream_unavailable`. */
export type ChannelRpcPort = {
  getContractChannelInfo(channel: string): Promise<ContractChannelInfo>;
};

export type ChannelCacheOptions = {
  /** How long a cached result is trusted before the next call re-queries the
   * contract. @default 5000 */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. @default Date.now */
  now?: () => number;
};

const DEFAULT_TTL_MS = 5_000;

function toChannelInfo(raw: ContractChannelInfo): ChannelInfo {
  if (!raw.found) {
    return { status: "not_found" };
  }
  return raw.closing ? { status: "closing", depositRaw: raw.depositRaw } : { status: "open", depositRaw: raw.depositRaw };
}

/**
 * Builds the real `ChannelDepositPort` (`agent/routes/vouchers.ts`) from a
 * `ChannelRpcPort`, caching each channel's info for `ttlMs`. A cache miss (or
 * expiry) always re-queries; a hit never touches the network. Per-channel —
 * a hot channel and an idle one never interfere.
 */
export function createChannelCache(
  rpcPort: ChannelRpcPort,
  options: ChannelCacheOptions = {},
): { getChannelInfo(channel: string): Promise<ChannelInfo> } {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; info: ChannelInfo }>();

  return {
    async getChannelInfo(channel: string): Promise<ChannelInfo> {
      const cached = cache.get(channel);
      if (cached !== undefined && cached.expiresAt > now()) {
        return cached.info;
      }
      const raw = await rpcPort.getContractChannelInfo(channel);
      const info = toChannelInfo(raw);
      cache.set(channel, { expiresAt: now() + ttlMs, info });
      return info;
    },
  };
}
