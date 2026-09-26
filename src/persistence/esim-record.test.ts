// Tests for the esim-record persistence layer (docs/citrus-mobile-spec.md v2
// R11): atomic tmp+fsync+rename writes, serialized per-iccid updates, and —
// the regression this suite guards — the defund's NESTED bigints survive a
// write → read → reopen round-trip (JSON.stringify cannot serialize a BigInt,
// so the money fields are stringified on disk and revived on read).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openEsimStore, type EsimRecordRow } from "./esim-record.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "esim-record-"));
}

function seedRow(iccid: string, over: Partial<EsimRecordRow> = {}): EsimRecordRow {
  const now = new Date().toISOString();
  return {
    v: 1,
    iccid,
    userRef: `user_of_${iccid}`,
    channelId: "C-TEST-1",
    status: "active",
    fundedMicroUsd: 5_000_000n,
    chargedBaselineMicroUsd: 1_000_000n,
    pendingFund: null,
    defundPending: false,
    defund: null,
    closing: null,
    lpaString: `LPA:1$test.smdp$${iccid}`,
    qrCode: `data:image/png;base64,qr_${iccid}`,
    directInstallUrl: `https://direct/${iccid}`,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

test("round-trip: los bigint raíz (funded/charged) y los ANIDADOS del defund se reviven tras reabrir el archivo", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "esim.json");
  const store = openEsimStore(filePath);
  const now = "2026-09-24T10:00:00.000Z";
  await store.update("RT-1", () =>
    seedRow("RT-1", {
      status: "defund_pending",
      defundPending: true,
      defund: {
        solicitedAt: now,
        settlesInMinutes: 15,
        estimatedReturnMicroUsd: 2_000_000n,
        returnedMicroUsd: 1_234_567n,
        settledAt: now,
      },
    }),
  );

  // El write no debe lanzar (regresión: JSON.stringify no serializa BigInt).
  const raw = fs.readFileSync(filePath, "utf8");
  assert.equal(raw.includes('"estimatedReturnMicroUsd": "2000000"'), true);
  assert.equal(raw.includes('"returnedMicroUsd": "1234567"'), true);

  const first = store.get("RT-1")!;
  assert.equal(first.fundedMicroUsd, 5_000_000n);
  assert.equal(first.defund!.estimatedReturnMicroUsd, 2_000_000n);
  assert.equal(first.defund!.returnedMicroUsd, 1_234_567n);

  // Cierre + reapertura: lo que hay en disco se revive a BigInt otra vez.
  const reopened = openEsimStore(filePath);
  const again = reopened.get("RT-1")!;
  assert.equal(again.defund!.estimatedReturnMicroUsd, 2_000_000n);
  assert.equal(again.defund!.returnedMicroUsd, 1_234_567n);
  assert.equal(again.defund!.settledAt, now);
});

test("round-trip: un defund pendiente (returnedMicroUsd null) sobrevive sin volverse string", async () => {
  const dir = tempDir();
  const store = openEsimStore(path.join(dir, "esim.json"));
  const now = "2026-09-24T10:00:00.000Z";
  await store.update("RT-NULL", () =>
    seedRow("RT-NULL", {
      defundPending: true,
      defund: {
        solicitedAt: now,
        settlesInMinutes: 15,
        estimatedReturnMicroUsd: 0n,
        returnedMicroUsd: null,
        settledAt: null,
      },
    }),
  );
  const reopened = openEsimStore(path.join(dir, "esim.json"));
  const row = reopened.get("RT-NULL")!;
  assert.equal(row.defund!.returnedMicroUsd, null);
  assert.equal(row.defund!.settledAt, null);
  assert.equal(row.defund!.estimatedReturnMicroUsd, 0n);
});

test("round-trip: pendingFund sobrevive (el estado que reconcilia FundingService tras un crash, R5)", async () => {
  const dir = tempDir();
  const store = openEsimStore(path.join(dir, "esim.json"));
  await store.update("PF-1", () =>
    seedRow("PF-1", {
      pendingFund: { amountCents: 333, walletBeforeCents: 0, requestedAt: "2026-09-24T10:00:00.000Z" },
    }),
  );
  const reopened = openEsimStore(path.join(dir, "esim.json"));
  assert.deepEqual(reopened.get("PF-1")!.pendingFund, {
    amountCents: 333,
    walletBeforeCents: 0,
    requestedAt: "2026-09-24T10:00:00.000Z",
  });
});

test("update es serializado por iccid y persiste la mutación: la fila nueva se lee fresca de disco", async () => {
  const dir = tempDir();
  const store = openEsimStore(path.join(dir, "esim.json"));
  await store.update("MUT-1", () => seedRow("MUT-1"));
  await store.update("MUT-1", (r) => ({ ...r!, status: "cut", updatedAt: "2026-09-24T11:00:00.000Z" }));
  const row = store.get("MUT-1")!;
  assert.equal(row.status, "cut");
  assert.equal(store.get("MUT-1")!.updatedAt, "2026-09-24T11:00:00.000Z");
  assert.equal(row.defund, null);
});

test("getByUserRef devuelve la fila del userRef y list() el snapshot completo", async () => {
  const dir = tempDir();
  const store = openEsimStore(path.join(dir, "esim.json"));
  await store.update("A-1", () => seedRow("A-1"));
  await store.update("B-2", () => seedRow("B-2"));
  assert.equal(store.getByUserRef("user_of_A-1")!.iccid, "A-1");
  assert.equal(store.getByUserRef("no-such") , undefined);
  assert.deepEqual(store.list().map((r) => r.iccid).sort(), ["A-1", "B-2"]);
  assert.equal(store.get("no-such"), undefined);
});

test("un archivo corrupto (crash a mitad de escritura) se trata como vacío, no revienta el proceso", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "esim.json");
  fs.writeFileSync(filePath, "{ \"v\": 1, \"iccid\": trunca");
  const store = openEsimStore(filePath);
  assert.equal(store.list().length, 0);
});