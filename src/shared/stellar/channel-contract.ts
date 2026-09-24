// Low-level `one-way-channel` contract driver (stage 2, WU6/WU7). Centralizes
// every hand-rolled Soroban call the spike (scratchpad/spike/stage2-spike.md)
// proved necessary because `@stellar/mpp` wraps only `close`,
// `getChannelState`, and `watchChannel` (Part A) — `open`, `top_up`,
// `close_start`, `refund`, and the raw getters (`deposited`, `balance`, ...)
// have no SDK wrapper at all and must be built directly with
// `@stellar/stellar-sdk` (simulate -> prepare -> sign -> send), exactly as
// `scratchpad/spike/lib-helpers.mjs` and
// `scratchpad/spike/run-a-open-and-close-start.mjs` did.
//
// Deviation from design 4.1's original testability rule (documented in
// existing code comments as "only config/boot.ts and agent/charge-client.ts
// touch the SDK"): this module is a THIRD, deliberate exception. It is a
// thin, deterministic driver with no business logic (no reason mapping, no
// persistence, no retries) — `config/boot.ts` builds the actual ports
// (`SignerPort`, `ChannelRpcPort`, `ChannelClosePort`, `ChannelWatchPort`,
// `TrustlinePort`) on top of it, and the two CLIs (`agent/channel.ts`,
// `server/channel-admin.ts`) call it directly, exactly like
// `scripts/preflight.ts` already does with the Horizon SDK. No business
// logic module (`agent/routes/vouchers.ts`, `agent/channel-cache.ts`,
// `server/channel-service.ts`, `server/close-monitor.ts`) imports this file
// directly — they only ever see a port. This avoids duplicating ~150 lines
// of contract-call boilerplate between `config/boot.ts` and two CLIs while
// keeping every business-logic module unit-testable with a fake.

import { createHash } from "node:crypto";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { networkPassphrase, type Network } from "./network.ts";

/** All-zeros source account used for free, read-only simulations (spike Part
 * A/C — matches `@stellar/mpp`'s own `ALL_ZEROS` constant). */
export const ALL_ZEROS_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Domain separator the contract signs commitments under (spike Part A,
 * `dist/channel/commitment.js`). */
export const COMMITMENT_DOMAIN = "chancmmt";

/**
 * WASM hash of the only `one-way-channel` revision confirmed live on testnet
 * without a Rust/cargo/`stellar` CLI toolchain (spike Part C preamble): the
 * SDK's own public e2e demo output names it, and a zero-cost
 * `getLedgerEntries` simulation confirmed the code entry is still served.
 * KNOWN LIMITATION: this specific revision has no `settle` function and no
 * `withdrawn` getter (see docs/sdd/payments-mpp.md §6, Lote E). Building the
 * current `main` branch from source requires that toolchain and is out of
 * scope here.
 */
export const SPIKE_WASM_HASH_HEX = "f9b7fdf860ce427097226f45f72b336763ca55d46c967076a94eb9682d8c484b";

export type ChannelContractDeps = {
  rpcUrl: string;
  network: Network;
};

function rpcServerFor(deps: ChannelContractDeps): rpc.Server {
  return new rpc.Server(deps.rpcUrl);
}

function baseTxBuilder(deps: ChannelContractDeps, sourceAccount: Account, fee = "100") {
  return new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: networkPassphrase(deps.network),
  });
}

export type SimulateGetterResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Zero-cost, read-only simulation of a no-argument (or scalar-argument)
 * contract getter — the exact pattern `scratchpad/spike/lib-helpers.mjs`'s
 * `simulateGetter` and `read-demo-channel.mjs` use. Never throws. */
export async function simulateGetter(
  deps: ChannelContractDeps,
  channel: string,
  fnName: string,
  ...args: xdr.ScVal[]
): Promise<SimulateGetterResult> {
  try {
    const server = rpcServerFor(deps);
    const contract = new Contract(channel);
    const account = new Account(ALL_ZEROS_ACCOUNT, "0");
    const call = contract.call(fnName, ...args);
    const tx = baseTxBuilder(deps, account).addOperation(call).setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      return { ok: false, error: `simulation of ${fnName} failed: ${JSON.stringify(sim)}`.slice(0, 500) };
    }
    return { ok: true, value: scValToNative(sim.result!.retval) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `balance()` — always present on every known revision (spike Part B). */
export async function getBalanceRaw(deps: ChannelContractDeps, channel: string): Promise<bigint> {
  const result = await simulateGetter(deps, channel, "balance");
  if (!result.ok) throw new Error(`getBalanceRaw: ${result.error}`);
  return BigInt(result.value as bigint | number | string);
}

/** Generic SEP-41 `balance(address)` read (spike `lib-helpers.mjs::
 * usdcBalance`) — used for the pre-close trustline-adjacent check and the
 * post-close balance-delta assertion (CL-R9, CL-R10). Free, read-only. */
export async function getSep41BalanceRaw(
  deps: ChannelContractDeps,
  tokenContract: string,
  accountId: string,
): Promise<bigint> {
  const result = await simulateGetter(deps, tokenContract, "balance", nativeToScVal(accountId, { type: "address" }));
  if (!result.ok) throw new Error(`getSep41BalanceRaw: ${result.error}`);
  return BigInt(result.value as bigint | number | string);
}

/**
 * `deposited()` — MISSING on the wasm revision this project deploys against
 * (spike Part C: "deposited/withdrawn → both fail, function not found").
 * Returns `undefined` instead of throwing when the getter does not exist, so
 * callers can fall back to a locally tracked deposit record
 * (`data/channel-{network}.json`, written by `agent/channel.ts`'s `open`/
 * `top-up` subcommands) — see docs/sdd/payments-mpp.md §6, Lote E for the
 * full deviation writeup.
 */
export async function tryGetDepositedRaw(
  deps: ChannelContractDeps,
  channel: string,
): Promise<bigint | undefined> {
  const result = await simulateGetter(deps, channel, "deposited");
  if (!result.ok) return undefined;
  return BigInt(result.value as bigint | number | string);
}

export type ChannelIdentity = {
  token: string;
  from: string;
  to: string;
  refundWaitingPeriodLedgers: number;
};

/** Reads the four static getters every known revision exposes (spike Part
 * B). Throws if the channel does not exist / is not a deployed instance of
 * this contract — callers map that to `channel_not_found`. */
export async function getChannelIdentity(
  deps: ChannelContractDeps,
  channel: string,
): Promise<ChannelIdentity> {
  const [token, from, to, refundWaitingPeriod] = await Promise.all([
    simulateGetter(deps, channel, "token"),
    simulateGetter(deps, channel, "from"),
    simulateGetter(deps, channel, "to"),
    simulateGetter(deps, channel, "refund_waiting_period"),
  ]);
  if (!token.ok || !from.ok || !to.ok || !refundWaitingPeriod.ok) {
    const errors = [token, from, to, refundWaitingPeriod]
      .filter((r): r is { ok: false; error: string } => !r.ok)
      .map((r) => r.error)
      .join("; ");
    throw new Error(`getChannelIdentity: channel not found or not readable: ${errors}`);
  }
  return {
    token: token.value as string,
    from: from.value as string,
    to: to.value as string,
    refundWaitingPeriodLedgers: Number(refundWaitingPeriod.value),
  };
}

/** Zero-cost simulation of `prepare_commitment(amount)` — returns the raw
 * XDR bytes to sign (spike Part A/C). */
export async function prepareCommitmentBytes(
  deps: ChannelContractDeps,
  channel: string,
  amountRaw: bigint,
): Promise<Buffer> {
  const server = rpcServerFor(deps);
  const contract = new Contract(channel);
  const account = new Account(ALL_ZEROS_ACCOUNT, "0");
  const call = contract.call("prepare_commitment", nativeToScVal(amountRaw, { type: "i128" }));
  const tx = baseTxBuilder(deps, account).addOperation(call).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`prepare_commitment simulation failed: ${JSON.stringify(sim)}`.slice(0, 500));
  }
  return Buffer.from(sim.result!.retval.bytes());
}

export type DecodedCommitment = {
  domain: string;
  channel: string;
  amount: bigint;
  networkHash: Buffer;
};

/** Decodes the `{amount, channel, domain, network}` XDR map `prepare_
 * commitment` returns (spike Part A: confirmed byte-for-byte against a live
 * simulation). Offline, deterministic — no network call. */
export function decodeCommitmentBytes(bytes: Buffer): DecodedCommitment {
  const scv = xdr.ScVal.fromXDR(bytes);
  const native = scValToNative(scv) as Record<string, unknown>;
  if (
    typeof native.domain !== "string" ||
    typeof native.channel !== "string" ||
    native.network === undefined
  ) {
    throw new Error("decodeCommitmentBytes: unexpected commitment map shape");
  }
  return {
    domain: native.domain,
    channel: native.channel,
    amount: BigInt(native.amount as bigint | number | string),
    networkHash: Buffer.from(native.network as Uint8Array),
  };
}

/**
 * Verifies a simulated commitment binds to the channel/amount/network we
 * intended before ever signing it — the same defense
 * `@stellar/mpp`'s client-side `assertCommitmentBinds()` applies (spike Part
 * A). Throws a descriptive error on any mismatch.
 */
export function assertCommitmentBinds(
  bytes: Buffer,
  expected: { channel: string; amount: bigint; network: Network },
): void {
  const decoded = decodeCommitmentBytes(bytes);
  if (decoded.domain !== COMMITMENT_DOMAIN) {
    throw new Error(`commitment domain mismatch: expected "${COMMITMENT_DOMAIN}", got "${decoded.domain}"`);
  }
  if (decoded.channel !== expected.channel) {
    throw new Error(`commitment channel mismatch: expected ${expected.channel}, got ${decoded.channel}`);
  }
  if (decoded.amount !== expected.amount) {
    throw new Error(`commitment amount mismatch: expected ${expected.amount}, got ${decoded.amount}`);
  }
  const expectedHash = createHash("sha256").update(networkPassphrase(expected.network)).digest();
  if (!decoded.networkHash.equals(expectedHash)) {
    throw new Error("commitment network mismatch: does not match the expected network passphrase hash");
  }
}

/**
 * Builds a `Keypair` from `COMMITMENT_SECRET` — a Stellar strkey secret
 * seed (`S...`, 56 chars, `config/env.ts`'s `isStellarSecretSeed`), the same
 * format `SIGNER_SECRET`/`FEE_PAYER_SECRET` use, and what
 * `Keypair.random()` produces (the spike generated the commitment key this
 * way — `scratchpad/spike/run-c-open-channel2.mjs`).
 *
 * NOT a raw 32-byte ed25519 seed hex string, even though `COMMITMENT_PUBKEY`
 * (the OTHER half of this same keypair) is stored as raw public-key hex
 * (`Buffer.from(commitmentKp.rawPublicKey()).toString('hex')` — required by
 * the contract constructor's `BytesN<32>` argument and by
 * `verifyCommitmentSignature` below). Mixed formats for the two halves of
 * one keypair, confirmed correct empirically against the live `.env`:
 * `Keypair.fromSecret(COMMITMENT_SECRET).rawPublicKey()` hex-encodes to
 * exactly `COMMITMENT_PUBKEY`. An earlier revision of this module
 * (`commitmentKeypairFromHexSeed`, since renamed) wrongly assumed
 * `COMMITMENT_SECRET` was also raw hex and called
 * `Keypair.fromRawEd25519Seed(Buffer.from(secret, "hex"))` — silently wrong
 * for an `S...` string (not valid hex, `Buffer.from` does not throw, it
 * just stops at the first invalid nibble) — caught while preparing the
 * stage-2 live smoke test against the real, pre-provisioned channel #2
 * `.env`, see docs/sdd/payments-mpp.md §6, Lote E.
 */
export function commitmentKeypairFromSecret(commitmentSecret: string): Keypair {
  return Keypair.fromSecret(commitmentSecret);
}

/** ed25519-signs `bytes` and returns `{signature, commitmentPubkey}` as hex,
 * matching `agent/signer.ts`'s `SignResult` shape exactly. */
export function signCommitmentBytes(
  commitmentSecret: string,
  bytes: Buffer,
): { signature: string; commitmentPubkey: string } {
  const keypair = commitmentKeypairFromSecret(commitmentSecret);
  const signature = keypair.sign(bytes).toString("hex");
  const commitmentPubkey = Buffer.from(keypair.rawPublicKey()).toString("hex");
  return { signature, commitmentPubkey };
}

/** Verifies an ed25519 signature against a 64-hex commitment public key
 * (`COMMITMENT_PUBKEY`), matching the SDK server's own local verification
 * recipe (spike Part A: "commitmentKP.verify(bytes, signatureBytes) locally,
 * no on-chain call needed"). */
export function verifyCommitmentSignature(
  commitmentPubkeyHex: string,
  bytes: Buffer,
  signatureHex: string,
): boolean {
  // No `Keypair.fromRawEd25519PublicKey` exists on this SDK version — only
  // `fromRawEd25519Seed` (a secret) and `fromPublicKey` (a G... strkey, not
  // raw bytes). The constructor accepts a raw public key buffer directly.
  const keypair = new Keypair({ type: "ed25519", publicKey: Buffer.from(commitmentPubkeyHex, "hex") });
  try {
    return keypair.verify(bytes, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Generic prepare -> sign -> send -> poll helper (spike
 * `lib-helpers.mjs::prepareSignSend`/`signAndSend`). Polls up to `maxAttempts`
 * times, `delayMs` apart, for the submitted tx to leave `NOT_FOUND`. */
export async function prepareSignSendPoll(
  deps: ChannelContractDeps,
  tx: import("@stellar/stellar-sdk").Transaction,
  signers: Keypair[],
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<{ hash: string; result: rpc.Api.GetTransactionResponse }> {
  const server = rpcServerFor(deps);
  const prepared = await server.prepareTransaction(tx);
  for (const signer of signers) prepared.sign(signer);
  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status !== "PENDING") {
    throw new Error(
      `submission not PENDING: ${sendResult.status} ${JSON.stringify(sendResult.errorResult ?? "")}`,
    );
  }
  const hash = sendResult.hash;
  const maxAttempts = options.maxAttempts ?? 30;
  const delayMs = options.delayMs ?? 2000;
  let result: rpc.Api.GetTransactionResponse | undefined;
  for (let i = 0; i < maxAttempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await server.getTransaction(hash);
    if (result.status !== "NOT_FOUND") break;
  }
  if (result === undefined) {
    throw new Error(`submission ${hash} never returned a status`);
  }
  return { hash, result };
}

export type OpenChannelParams = {
  funderPublicKey: string;
  recipientPublicKey: string;
  tokenContract: string;
  commitmentPubkeyHex: string;
  depositRaw: bigint;
  refundWaitingPeriodLedgers: number;
  wasmHashHex?: string;
};

/** Builds the unprepared `createCustomContract` open transaction (CL-R1;
 * spike Part C/implementation brief #1). Deploys a NEW instance of the
 * shared, content-addressed wasm code — never re-uploads it. */
export async function buildOpenChannelTx(
  deps: ChannelContractDeps,
  params: OpenChannelParams,
): Promise<import("@stellar/stellar-sdk").Transaction> {
  const server = rpcServerFor(deps);
  const account = await server.getAccount(params.funderPublicKey);
  const createOp = Operation.createCustomContract({
    address: new Address(params.funderPublicKey),
    wasmHash: Buffer.from(params.wasmHashHex ?? SPIKE_WASM_HASH_HEX, "hex"),
    constructorArgs: [
      nativeToScVal(params.tokenContract, { type: "address" }),
      nativeToScVal(params.funderPublicKey, { type: "address" }),
      nativeToScVal(Buffer.from(params.commitmentPubkeyHex, "hex"), { type: "bytes" }),
      nativeToScVal(params.recipientPublicKey, { type: "address" }),
      nativeToScVal(params.depositRaw, { type: "i128" }),
      nativeToScVal(params.refundWaitingPeriodLedgers, { type: "u32" }),
    ],
  });
  return baseTxBuilder(deps, account).addOperation(createOp).setTimeout(60).build();
}

/** Extracts the new channel contract's address from a successful open's
 * `getTransaction` result (spike: `Address.fromScVal(getResult.returnValue)`). */
export function channelAddressFromOpenResult(result: rpc.Api.GetSuccessfulTransactionResponse): string {
  return Address.fromScVal(result.returnValue!).toString();
}

async function buildSimpleCall(
  deps: ChannelContractDeps,
  sourcePublicKey: string,
  channel: string,
  fnName: string,
  args: xdr.ScVal[],
): Promise<import("@stellar/stellar-sdk").Transaction> {
  const server = rpcServerFor(deps);
  const account = await server.getAccount(sourcePublicKey);
  const op = new Contract(channel).call(fnName, ...args);
  return baseTxBuilder(deps, account).addOperation(op).setTimeout(60).build();
}

/** `top_up(amount)` — funder-authorized, callable in any channel state
 * (spike S4/Part B). */
export function buildTopUpTx(
  deps: ChannelContractDeps,
  funderPublicKey: string,
  channel: string,
  amountRaw: bigint,
): Promise<import("@stellar/stellar-sdk").Transaction> {
  return buildSimpleCall(deps, funderPublicKey, channel, "top_up", [
    nativeToScVal(amountRaw, { type: "i128" }),
  ]);
}

/** `close_start()` — funder-authorized unilateral exit (CL-R3/R13). */
export function buildCloseStartTx(
  deps: ChannelContractDeps,
  funderPublicKey: string,
  channel: string,
): Promise<import("@stellar/stellar-sdk").Transaction> {
  return buildSimpleCall(deps, funderPublicKey, channel, "close_start", []);
}

/** `refund()` — funder-authorized, only succeeds once `refund_waiting_
 * period` ledgers have elapsed since `close_start` (spike Part B). */
export function buildRefundTx(
  deps: ChannelContractDeps,
  funderPublicKey: string,
  channel: string,
): Promise<import("@stellar/stellar-sdk").Transaction> {
  return buildSimpleCall(deps, funderPublicKey, channel, "refund", []);
}

export function feeChargedOf(result: rpc.Api.GetTransactionResponse): string {
  try {
    // @ts-expect-error -- resultXdr is only present on a successful/failed
    // response, guarded by the caller checking `status` first; this helper
    // is best-effort evidence formatting, never a business decision.
    return result.resultXdr.feeCharged().toString();
  } catch {
    return "n/a";
  }
}
