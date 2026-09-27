// FakeProvider: deterministic in-memory ConnectivityProvider for tests and
// demos (the `fake` backend — `CONNECTIVITY_PROVIDER=fake`, the default).
//
// It implements the SAME unit contract as the interface (micro-USD + cents):
// business tests never branch on the backend, they assert on the seam. The
// internal state is a plain in-memory map so tests can drive scenarios the
// real Citrus API would only produce over minutes (consumption rising,
// defund settling after `settlesInMinutes`, wallet dropping to 0).

import { createHash } from "node:crypto";
import type { ConnectivityProvider, EsimRecord, SimUsage } from "./ConnectivityProvider.ts";

export type FakeEsimState = {
  iccid: string;
  userRef: string;
  label: string | undefined;
  status: string; // pending | active | suspended | terminated
  chargedMicroUsd: bigint;
  walletMicroUsd: bigint;
  defundPending: boolean;
  defundSolicitedAt: string | null;
  defundSettlesInMinutes: number;
  defundEstimatedReturnMicroUsd: bigint;
  fundingRequests: { amountCents: number; at: string }[];
};

let nextSerial = 1;

export class FakeProvider implements ConnectivityProvider {
  private readonly byIccid = new Map<string, FakeEsimState>();
  private readonly byUserRef = new Map<string, string>();
  private now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Test seam: the record behind an iccid, to assert on or mutate. */
  sim(iccid: string): FakeEsimState {
    const state = this.byIccid.get(iccid);
    if (state === undefined) {
      throw new Error(`FakeProvider: no hay eSIM para el iccid ${iccid}`);
    }
    return state;
  }

  /** Records ALL fake eSIMs (diagnostics for tests/demos). */
  list(): FakeEsimState[] {
    return [...this.byIccid.values()];
  }

  async provisionEsim(userRef: string, label?: string): Promise<EsimRecord> {
    const existingIccid = this.byUserRef.get(userRef);
    if (existingIccid !== undefined) {
      const existing = this.byIccid.get(existingIccid)!;
      if (existing.status !== "terminated") {
        return this.recordFor(existing);
      }
      this.byUserRef.delete(userRef);
      this.byIccid.delete(existingIccid);
    }
    const iccid = `fake_${String(nextSerial++).padStart(4, "0")}`;
    const state: FakeEsimState = {
      iccid,
      userRef,
      label,
      status: "pending",
      chargedMicroUsd: 0n,
      walletMicroUsd: 0n,
      defundPending: false,
      defundSolicitedAt: null,
      defundSettlesInMinutes: 30,
      defundEstimatedReturnMicroUsd: 0n,
      fundingRequests: [],
    };
    this.byIccid.set(iccid, state);
    this.byUserRef.set(userRef, iccid);
    const record = this.recordFor(state);
    // Citrus reports an eSIM as `active` only after a profile download; the
    // fake goes straight to active so demos don't need an extra step.
    state.status = "active";
    return record;
  }

  async topUp(iccid: string, amountCents: number): Promise<void> {
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new RangeError(`FakeProvider topUp: amountCents debe ser un entero positivo, recibí ${amountCents}`);
    }
    if (amountCents > 10_000) {
      throw new RangeError("FakeProvider topUp: Citrus rechaza recargas sobre 10 000 centavos (100 USD)");
    }
    const state = this.sim(iccid);
    if (state.status === "terminated") {
      throw new Error(`FakeProvider topUp: la eSIM ${iccid} está terminada`);
    }
    if (state.defundPending) {
      throw new Error(`FakeProvider topUp: la eSIM ${iccid} tiene un defund pendiente — no se puede recargar`);
    }
    state.walletMicroUsd += BigInt(amountCents) * 10_000n;
    state.fundingRequests.push({ amountCents, at: this.now().toISOString() });
    if (state.status === "suspended" && state.defundPending === false) {
      // A successful fund reactivates Citrus eSIMs (the prepaid wallet is the
      // data limit): the caller decides whether that is desired (FundingService
      // skips while the session is closing).
      state.status = "active";
    }
  }

  async getUsage(iccid: string): Promise<SimUsage> {
    const state = this.sim(iccid);
    return this.usageFor(state);
  }

  async suspend(iccid: string): Promise<void> {
    const state = this.sim(iccid);
    if (state.status !== "terminated") {
      state.status = "suspended";
    }
  }

  async resume(iccid: string): Promise<void> {
    const state = this.sim(iccid);
    if (state.status === "suspended" && !state.defundPending) {
      state.status = "active";
    }
  }

  async refundUnused(iccid: string): Promise<void> {
    const state = this.sim(iccid);
    if (state.defundPending) {
      return; // idempotente; Citrus responde DEFUND_ALREADY_PENDING
    }
    state.defundPending = true;
    state.defundSolicitedAt = this.now().toISOString();
    state.defundEstimatedReturnMicroUsd = state.walletMicroUsd;
    state.status = "pending";
  }

  /** Test seam: simulates Citrus settling the defund (wallet -> 0, refund
   * made). Real Citrus does this ~`settlesInMinutes` later; the usage loop /
   * SessionCloser see the outcome through getUsage(), so tests advance the
   * fake explicitly. */
  settleDefund(iccid: string): void {
    const state = this.sim(iccid);
    if (!state.defundPending) {
      throw new Error(`FakeProvider settleDefund: la eSIM ${iccid} no tiene un defund pendiente`);
    }
    state.defundPending = false;
    state.defundSolicitedAt = state.defundSolicitedAt ?? this.now().toISOString();
    state.walletMicroUsd = 0n;
    state.status = "active";
  }

  /** Test seam: advance the lifetime charged figure (the only way usage grows
   * in the fake — the real provider reads `total_data_charged_usd`). */
  setChargedUsd(iccid: string, chargedMicroUsd: bigint): void {
    const state = this.sim(iccid);
    state.chargedMicroUsd = chargedMicroUsd;
  }

  async terminate(iccid: string): Promise<void> {
    const state = this.sim(iccid);
    if (state.walletMicroUsd > 0n) {
      throw new Error(`FakeProvider terminate: la eSIM ${iccid} aún tiene saldo — defund primero`);
    }
    state.status = "terminated";
    this.byUserRef.delete(state.userRef);
    this.byIccid.delete(iccid);
  }

  private recordFor(state: FakeEsimState): EsimRecord {
    return {
      iccid: state.iccid,
      lpaString: `LPA:1$fake.smdp$${state.userRef}`,
      qrCode: fakeQrDataUri(state.iccid),
      directInstallUrl: `https://fake.directinstall/${state.iccid}`,
      status: state.status,
    };
  }

  private usageFor(state: FakeEsimState): SimUsage {
    return {
      chargedMicroUsd: state.chargedMicroUsd,
      walletMicroUsd: state.walletMicroUsd,
      status: state.status,
      asOf: this.now().toISOString(),
    };
  }
}

/**
 * Imagen con aspecto de QR (SVG válido, 25×25 módulos) derivada del ICCID,
 * para que la app muestre algo real en demos. NO es escaneable: la eSIM
 * falsa no existe.
 */
function fakeQrDataUri(seed: string): string {
  const size = 25;
  const bits = createHash("sha512").update(`fake-qr:${seed}`).digest();
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
  const finder = (ox: number, oy: number) =>
    `<rect x="${ox}" y="${oy}" width="7" height="7" fill="#0F172A"/>` +
    `<rect x="${ox + 1}" y="${oy + 1}" width="5" height="5" fill="#FFFFFF"/>` +
    `<rect x="${ox + 2}" y="${oy + 2}" width="3" height="3" fill="#0F172A"/>`;
  let modules = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inFinder(x, y)) continue;
      const i = y * size + x;
      if ((bits[i % bits.length]! >> (i % 8)) & 1) {
        modules += `<rect x="${x}" y="${y}" width="1" height="1" fill="#0F172A"/>`;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${size + 4} ${size + 4}" width="240" height="240" shape-rendering="crispEdges">` +
    `<rect x="-2" y="-2" width="${size + 4}" height="${size + 4}" fill="#FFFFFF"/>` +
    finder(0, 0) + finder(size - 7, 0) + finder(0, size - 7) + modules +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
