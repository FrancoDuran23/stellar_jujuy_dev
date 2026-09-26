// FakeProvider: deterministic in-memory ConnectivityProvider for tests and
// demos (the `fake` backend — `CONNECTIVITY_PROVIDER=fake`, the default).
//
// It implements the SAME unit contract as the interface (micro-USD + cents):
// business tests never branch on the backend, they assert on the seam. The
// internal state is a plain in-memory map so tests can drive scenarios the
// real Citrus API would only produce over minutes (consumption rising,
// defund settling after `settlesInMinutes`, wallet dropping to 0).

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
      qrCode: `data:image/png;base64,fake_qr_${state.iccid}`,
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