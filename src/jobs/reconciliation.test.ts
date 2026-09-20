import { test } from "node:test";
import assert from "node:assert/strict";
import { mbToBytes, runReconciliation } from "./reconciliation.ts";
import type { ConnectivityProvider } from "../providers/connectivity/ConnectivityProvider.ts";
import type { ConnectivitySession } from "../models/ConnectivitySession.ts";

function session(override?: Partial<ConnectivitySession>): ConnectivitySession {
  return {
    id: "s1",
    userId: "u1",
    provider: "telnyx",
    simCardId: "sim-1",
    iccid: "iccid-1",
    channelId: "ch1",
    meteredBytes: 0n,
    carrierBytes: 0n,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...override,
  };
}

function providerReturning(usage: { mb: number; status: string }): ConnectivityProvider {
  return new Proxy({} as ConnectivityProvider, {
    get(_target, prop) {
      if (prop === "getUsage") {
        return async () => usage;
      }
      return async () => {
        throw new Error(`not a usage call: ${String(prop)}`);
      };
    },
  });
}

// --- mbToBytes: the ONE explicit MB → bytes conversion ---

test("mbToBytes converts with the carrier's decimal MB (1 MB = 1_000_000 bytes)", () => {
  assert.equal(mbToBytes(0), 0n);
  assert.equal(mbToBytes(1), 1_000_000n);
  assert.equal(mbToBytes(12.5), 12_500_000n);
  assert.equal(mbToBytes(0.001), 1_000n);
});

test("mbToBytes rounds fractional bytes to whole bytes", () => {
  // 0.0000004 MB would be 0.4 bytes — a carrier never reports this, but the
  // conversion must not emit float bytes anyway.
  assert.equal(mbToBytes(0.0000004), 0n);
});

test("mbToBytes rejects negative, NaN and infinite import", () => {
  assert.throws(() => mbToBytes(-1), RangeError);
  assert.throws(() => mbToBytes(Number.NaN), RangeError);
  assert.throws(() => mbToBytes(Number.POSITIVE_INFINITY), RangeError);
});

// --- runReconciliation updates carrierBytes and reports the diff ---

test("runReconciliation updates carrierBytes from provider MB and logs the diff", async () => {
  const s = session({ meteredBytes: 15_000_000n }); // gateway: 15 MB
  const lines: unknown[] = [];
  const result = await runReconciliation(s, {
    provider: providerReturning({ mb: 12.5, status: "enabled" }),
    logger: (line) => lines.push(line),
  });

  assert.equal(s.carrierBytes, 12_500_000n);
  assert.equal(result.carrierBytes, 12_500_000n);
  assert.equal(result.diffBytes, 2_500_000n); // 15 MB - 12.5 MB = +2.5 MB ahead

  const log = lines.find((l) => (l as { reason?: string }).reason === "reconciliation_diff");
  assert.ok(log, "se emite el diff informativo");
});

test("runReconciliation leaves carrierBytes untouched and returns today's diff on provider error", async () => {
  const s = session({ carrierBytes: 5_000_000n });
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

  assert.equal(s.carrierBytes, 5_000_000n);
  assert.equal(result.carrierBytes, 5_000_000n);
  assert.equal(result.diffBytes, s.meteredBytes - 5_000_000n);

  const log = lines.find((l) => (l as { reason?: string }).reason === "reconciliation_usage_unavailable");
  assert.ok(log, "el fallo se loguea sin reventar la cadena");
});