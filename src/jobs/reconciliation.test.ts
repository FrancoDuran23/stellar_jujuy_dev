import { test } from "node:test";
import assert from "node:assert/strict";
import { runReconciliation } from "./reconciliation.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";

function session(override?: Partial<ConnectivitySession>): ConnectivitySession {
  return {
    id: "s1",
    userId: "u1",
    provider: "citrus",
    iccid: "iccid-1",
    channelId: "ch1",
    chargedMicroUsd: 0n,
    chargedBaselineMicroUsd: 0n,
    fundedMicroUsd: 0n,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...override,
  };
}

function providerReturningUsage(usage: {
  chargedMicroUsd: bigint;
  walletMicroUsd: bigint;
  status: string;
}): ConnectivityProvider {
  return new Proxy({} as ConnectivityProvider, {
    get(_target, prop) {
      if (prop === "getUsage") {
        return async () => ({
          ...usage,
          asOf: "2026-01-01T00:01:00.000Z",
        });
      }
      return async () => {
        throw new Error(`not a usage call: ${String(prop)}`);
      };
    },
  });
}

// --- trip charged = charged − baseline (R13); wallet drift is diagnostic ---

test("runReconciliation computes tripCharged from charged − baseline and the wallet drift", async () => {
  const s = session({
    chargedBaselineMicroUsd: 1_000_000n, // 1 USDC already spent before the trip
    fundedMicroUsd: 3_000_000n, // 3 USDC wallet funded this trip
  });
  const lines: unknown[] = [];
  // Provider says: lifetime 2_600_000 (so trip = 1_600_000), wallet 1_400_000.
  const result = await runReconciliation(s, {
    provider: providerReturningUsage({
      chargedMicroUsd: 2_600_000n,
      walletMicroUsd: 1_400_000n,
      status: "active",
    }),
    logger: (line) => lines.push(line),
  });

  assert.equal(result.tripChargedMicroUsd, 1_600_000n);
  assert.equal(result.expectedWalletMicroUsd, 1_400_000n);
  assert.equal(result.driftMicroUsd, 0n); // provider agrees with the model
  assert.equal(s.chargedMicroUsd, 2_600_000n, "session refreshes the lifetime charge");

  const log = lines.find((l) => (l as { reason?: string }).reason === "reconciliation_diff");
  assert.ok(log, "se emite el diff informativo");
});

test("runReconciliation reports drift when the provider wallet deviates from the model", async () => {
  const s = session({
    chargedBaselineMicroUsd: 0n,
    fundedMicroUsd: 5_000_000n,
  });
  // Provider charged trips 2_000_000 but only 2_800_000 remains: model expects 3_000_000.
  const result = await runReconciliation(s, {
    provider: providerReturningUsage({
      chargedMicroUsd: 2_000_000n,
      walletMicroUsd: 2_800_000n,
      status: "active",
    }),
  });

  assert.equal(result.tripChargedMicroUsd, 2_000_000n);
  assert.equal(result.expectedWalletMicroUsd, 3_000_000n);
  assert.equal(result.driftMicroUsd, -200_000n);
});

test("runReconciliation guards charged below baseline (never negative trip bill)", async () => {
  const s = session({
    chargedBaselineMicroUsd: 9_000_000n,
    fundedMicroUsd: 4_000_000n,
  });
  // Stale read: lifetime charged BELOW the saved baseline → trip = 0.
  const result = await runReconciliation(s, {
    provider: providerReturningUsage({
      chargedMicroUsd: 8_000_000n,
      walletMicroUsd: 2_000_000n,
      status: "active",
    }),
  });

  assert.equal(result.tripChargedMicroUsd, 0n);
  assert.equal(result.expectedWalletMicroUsd, 4_000_000n); // funded only
  assert.equal(result.driftMicroUsd, -2_000_000n);
});

test("runReconciliation never throws on provider error and recomputes from the session", async () => {
  const s = session({
    chargedMicroUsd: 2_600_000n,
    chargedBaselineMicroUsd: 1_000_000n,
    fundedMicroUsd: 3_000_000n,
  });
  const lines: unknown[] = [];
  const failing = new Proxy({} as ConnectivityProvider, {
    get() {
      return async () => {
        throw new Error("usage unavailable");
      };
    },
  });

  const result = await runReconciliation(s, {
    provider: failing,
    logger: (line) => lines.push(line),
  });

  assert.equal(s.chargedMicroUsd, 2_600_000n, "session untouched");
  assert.equal(result.tripChargedMicroUsd, 1_600_000n);
  assert.equal(result.walletMicroUsd, 0n);
  assert.equal(result.driftMicroUsd, -1_400_000n);

  const log = lines.find(
    (l) => (l as { reason?: string }).reason === "reconciliation_usage_unavailable",
  );
  assert.ok(log, "el fallo se loguea sin reventar la cadena");
});