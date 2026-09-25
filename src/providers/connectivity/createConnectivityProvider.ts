// Provider factory (docs/citrus-mobile-spec.md v2 §7 R1): resolves the
// connected backend from `CONNECTIVITY_PROVIDER`. Default `fake` keeps the
// server, tests and demos working with no Citrus config at all; `citrus`
// validates the reseller config and fails fast naming the offending variable.
//
// Returns a bundle: the provider PLUS the durable esim-record store opened
// once per process — the usage loop, FundingService and SessionCloser must
// share the SAME store instance (each re-reads from disk, but writes must be
// serialized through one mutex).

import type { ConnectivityProvider } from "./ConnectivityProvider.ts";
import { FakeProvider } from "./FakeProvider.ts";
import { CitrusClient } from "./CitrusClient.ts";
import { CitrusProvider } from "./CitrusProvider.ts";
import type { EsimStore } from "../../persistence/esim-record.ts";
import { esimRecordPath, openEsimStore } from "../../persistence/esim-record.ts";

export type ConnectivityProviderKind = "fake" | "citrus";

export type ConnectivityEnv = {
  CONNECTIVITY_PROVIDER: ConnectivityProviderKind;
  CITRUS_API_KEY?: string;
  CITRUS_BASE_URL?: string;
  CITRUS_WEBHOOK_SECRET?: string;
  PRICE_PER_MB_RAW: bigint;
  STELLAR_NETWORK: string;
  DATA_DIR: string;
  CITRUS_REQUEST_TIMEOUT_MS?: number;
};

export type ConnectivityBundle = {
  kind: ConnectivityProviderKind;
  provider: ConnectivityProvider;
  esimStore: EsimStore;
};

export function createConnectivityProvider(env: ConnectivityEnv): ConnectivityBundle {
  const esimStore = openEsimStore(esimRecordPath(env.DATA_DIR, env.STELLAR_NETWORK));

  if (env.CONNECTIVITY_PROVIDER === "fake" || env.CONNECTIVITY_PROVIDER === undefined) {
    return { kind: "fake", provider: new FakeProvider(), esimStore };
  }

  if (env.CITRUS_API_KEY === undefined || env.CITRUS_API_KEY === "") {
    throw new Error(
      "Falta CITRUS_API_KEY — generala en el dashboard de Citrus (prefijo rsk_) y agregala al .env " +
      "antes de usar CONNECTIVITY_PROVIDER=citrus.",
    );
  }

  const client = new CitrusClient({
    apiKey: env.CITRUS_API_KEY,
    baseUrl: env.CITRUS_BASE_URL,
    ...(env.CITRUS_REQUEST_TIMEOUT_MS !== undefined
      ? { requestTimeoutMs: env.CITRUS_REQUEST_TIMEOUT_MS }
      : {}),
  });
  return {
    kind: "citrus",
    provider: new CitrusProvider({ client, esimStore }),
    esimStore,
  };
}