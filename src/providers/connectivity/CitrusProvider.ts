// CitrusProvider: the real ConnectivityProvider backed by CitrusClient plus
// the esim-record store (docs/citrus-mobile-spec.md v2 §7 R3/R4).
//
// This is the ONLY place the raw provider float (USD) becomes bigint micro-USD
// (interface contract): every method below converts at this edge and business
// code never sees a `number` dollar amount again.
//
// Extra responsibilities owned here (not in the client):
// - Provision idempotence: `provisionEsim(userRef)` reuses the user's
//   existing non-terminated eSIM (R4). Concurrency is serialized on the
//   esim-record mutex under key `esim:${userRef}` — two simultaneous calls
//   produce ONE eSIM and ONE $1.75 provision charge (R4 CA).
// - On `refundUnused`, the 202's settlement metadata
//   (`settles_in_minutes`/`estimated_return_usd`) is persisted to the store;
//   the SessionCloser reads the same record to drive its defund wait (R9).

import type { ConnectivityProvider, EsimRecord, SimUsage } from "./ConnectivityProvider.ts";
import type { CitrusClient } from "./CitrusClient.ts";
import type { EsimStore, EsimRecordRow, EsimRecordStatus } from "../../persistence/esim-record.ts";
import { CitrusTerminateWithBalanceError } from "../../shared/citrus-errors.ts";

/** USD (as Citrus reports a float) -> micro-USD bigint, rounded to the whole
 * micro. The ONLY USD→micro conversion in the whole connectivity layer. */
export function usdToMicroUsd(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) {
    return 0n;
  }
  return BigInt(Math.round(usd * 1_000_000));
}

export type CitrusProviderOptions = {
  client: CitrusClient;
  esimStore: EsimStore;
};

export class CitrusProvider implements ConnectivityProvider {
  private readonly client: CitrusClient;
  private readonly esimStore: EsimStore;

  constructor(options: CitrusProviderOptions) {
    this.client = options.client;
    this.esimStore = options.esimStore;
  }

  async provisionEsim(userRef: string, label?: string): Promise<EsimRecord> {
    // R4: lock per userRef so two concurrent provisions cannot double-charge.
    return this.esimStore.mutex.withChannelLock(`esim:${userRef}`, async () => {
      const existing = this.esimStore.getByUserRef(userRef);
      if (existing !== undefined && existing.status !== "terminated" && !existing.defundPending) {
        // A pending defund may still be settling — do NOT hand the defunded
        // eSIM back mid-settlement, the SessionCloser owns it until then.
        return this.recordFor(existing);
      }
      const provisioned = await this.client.provision({ endUserReference: userRef, label });
      const now = new Date().toISOString();
      const row: EsimRecordRow = {
        v: 1,
        iccid: provisioned.iccid,
        userRef,
        channelId: "",
        status: mapStatus(provisioned.status),
        fundedMicroUsd: 0n,
        chargedBaselineMicroUsd: 0n,
        pendingFund: null,
        defundPending: false,
        defund: null,
        closing: null,
        lpaString: provisioned.lpaString,
        qrCode: provisioned.qrCode,
        directInstallUrl: provisioned.directInstallUrl,
        createdAt: now,
        updatedAt: now,
      };
      await this.esimStore.update(provisioned.iccid, () => row);
      return this.recordFor(row);
    });
  }

  async topUp(iccid: string, amountCents: number): Promise<void> {
    // Exact cents -> USD dollars (0.01 granularity; an integer amount of
    // cents never produces a float artifact).
    const amountUsd = amountCents / 100;
    if (!Number.isSafeInteger(amountCents) || amountUsd <= 0 || amountUsd > 10_000) {
      throw new RangeError(
        `CitrusProvider topUp: amountCents debe estar entre 1 y 1_000_000 centavos, recibí ${amountCents}`,
      );
    }
    await this.client.fund(iccid, amountUsd);
  }

  async getUsage(iccid: string): Promise<SimUsage> {
    const esim = await this.client.detail(iccid);
    return {
      chargedMicroUsd: usdToMicroUsd(esim.totalDataChargedUsd ?? 0),
      walletMicroUsd: usdToMicroUsd(esim.walletBalanceUsd ?? 0),
      status: mapStatus(esim.status),
      asOf: new Date().toISOString(),
    };
  }

  async suspend(iccid: string): Promise<void> {
    await this.client.disable(iccid);
  }

  async resume(iccid: string): Promise<void> {
    await this.client.enable(iccid);
  }

  async refundUnused(iccid: string): Promise<void> {
    const result = await this.client.defund(iccid);
    const now = new Date().toISOString();
    await this.esimStore.update(iccid, (current) => {
      const base = current ?? missingRow(iccid);
      return {
        ...base,
        status: "defund_pending",
        defundPending: true,
        defund: {
          solicitedAt: now,
          settlesInMinutes: result.settlesInMinutes,
          estimatedReturnMicroUsd: usdToMicroUsd(result.estimatedReturnUsd),
          returnedMicroUsd: null,
          settledAt: null,
        },
        updatedAt: now,
      };
    });
  }

  async terminate(iccid: string): Promise<void> {
    const usage = await this.getUsage(iccid);
    if (usage.walletMicroUsd > 0n) {
      throw new CitrusTerminateWithBalanceError(iccid, usage.walletMicroUsd);
    }
    const current = this.esimStore.get(iccid);
    if (current !== undefined && current.defundPending) {
      throw new Error(`CitrusProvider terminate: la eSIM ${iccid} tiene un defund sin liquidar`);
    }
    await this.client.terminate(iccid);
    await this.esimStore.update(iccid, (row) => ({
      ...(row ?? missingRow(iccid)),
      status: "terminated",
      updatedAt: new Date().toISOString(),
    }));
  }

  private recordFor(row: EsimRecordRow): EsimRecord {
    return {
      iccid: row.iccid,
      lpaString: row.lpaString,
      qrCode: row.qrCode,
      directInstallUrl: row.directInstallUrl,
      status: row.status,
    };
  }
}

function mapStatus(status: string): EsimRecordStatus {
  switch (status) {
    case "pending":
      return "provisioned";
    case "active":
      return "active";
    case "suspended":
      return "cut";
    case "terminated":
      return "terminated";
    default:
      return "provisioned";
  }
}

function missingRow(iccid: string): EsimRecordRow {
  const now = new Date().toISOString();
  return {
    v: 1,
    iccid,
    userRef: "",
    channelId: "",
    status: "provisioned",
    fundedMicroUsd: 0n,
    chargedBaselineMicroUsd: 0n,
    pendingFund: null,
    defundPending: false,
    defund: null,
    closing: null,
    lpaString: "",
    qrCode: "",
    directInstallUrl: "",
    createdAt: now,
    updatedAt: now,
  };
}