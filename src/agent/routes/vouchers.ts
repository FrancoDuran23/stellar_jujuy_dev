// `POST /vouchers` (design 4.2, 4.3; spec 3.2 VE-R*, 3.3 AC-R*; T5.3, T5.4).
// The only seam with the gateway/meter: one HTTP request, one HTTP response,
// no callback, no queue (design 4.2). Split in two layers, same pattern as
// `server/charge-service.ts` + `server/routes/charge.ts`:
//
// - `createVoucherService` is pure business logic (idempotency, per-channel
//   mutex + coalescing, guardrails, signing, persistence, events) and never
//   touches Express. Tests call it directly with `Promise.all(...)` to
//   exercise true same-tick concurrency deterministically (T5.4) — going
//   through real HTTP sockets for that would be racy, since arrival order
//   over a real connection is not guaranteed to land inside one JS tick.
// - `createVouchersRoute` is the thin Express adapter: auth header, JSON
//   schema validation, and status-code mapping.
//
// Channel signing (T5.3 deviation, Lote C): the real ed25519 signer is WU6
// work (needs a real channel contract and the Stellar SDK, which design 4.1
// confines to `config/boot.ts`). This route depends only on `SignerPort`
// (`../signer.ts`) so it is fully testable today against
// `createFakeSigner()`; swapping in the real signer later requires no
// change here. Likewise, real channel deposit tracking (`agent/
// channel-cache.ts`, contract getters) is WU6 — `ChannelDepositPort` below
// is the same kind of seam, defaulting to a effectively-unlimited static
// deposit so `remaining` (VE-R7) is always well-defined without a real
// channel yet. Channel lifecycle reasons (`channel_exhausted`,
// `channel_not_found`, `channel_not_open`, `channel_closing`) are therefore
// out of scope for this route until WU6 wires a real deposit port.

import type { Request as ExpressRequest, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { emit as defaultEmit, type EmitInput } from "../../shared/events.ts";
import {
  buildUnsigned,
  message1Schema,
  message2SignedSchema,
  type Message1,
  type Message2,
} from "../../shared/messages.ts";
import type { Reason } from "../../shared/reasons.ts";
import { TimeoutError, UpstreamRpcError, withTimeout } from "../../shared/retry.ts";
import type { VoucherLog, VoucherIndexEntry, VoucherRecord } from "../../persistence/voucher-log.ts";
import { createChannelMutex } from "../mutex.ts";
import { checkGuardrails } from "../guardrails.ts";
import type { SignerPort } from "../signer.ts";

/**
 * Channel lifecycle status as seen by the agent's local, cached view of the
 * contract (WU6, `agent/channel-cache.ts`). Four states map 1:1 onto the M2
 * `reason` vocabulary's channel-lifecycle entries (spec 3.6/3.7):
 * `"open"` never fails on this alone; `"closing"` -> `channel_closing`;
 * `"not_found"` -> `channel_not_found`; `"not_open"` -> `channel_not_open`.
 * `depositRaw` is only meaningful for `"open"`/`"closing"` (exhaustion and
 * `remaining` both need it); a not-found/not-open channel has no deposit to
 * report.
 */
export type ChannelInfo =
  | { status: "open"; depositRaw: bigint }
  | { status: "closing"; depositRaw: bigint }
  | { status: "not_found" }
  | { status: "not_open" };

/**
 * Contract-backed deposit + lifecycle tracker (`agent/channel-cache.ts`,
 * WU6, wraps a lower-level `ChannelRpcPort` with a short TTL cache).
 * `createStaticDepositPort` below remains the WU5 ("escalón 1.5") stand-in
 * for tests and any deployment with no real channel contract yet.
 */
export type ChannelDepositPort = {
  getChannelInfo(channel: string): Promise<ChannelInfo>;
};

/** Effectively-unlimited deposit unless a test/deployment overrides it. */
export const DEFAULT_DEPOSIT_RAW = 2n ** 127n - 1n;

export function createStaticDepositPort(depositRaw: bigint = DEFAULT_DEPOSIT_RAW): ChannelDepositPort {
  return {
    async getChannelInfo() {
      return { status: "open", depositRaw };
    },
  };
}

function clampMin0(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bound applied to `depositPort.getDepositRaw` and `signer.sign` while the
 * per-channel mutex (VE-R12) holds the lock (review finding, Lote D): neither
 * is a business decision — both are outgoing calls to a dependency that can
 * hang — and an unbounded `await` there would hold the lock, and therefore
 * every queued `handle()` promise for that channel, forever. Overridable via
 * `PORT_CALL_TIMEOUT_MS` (`config/env.ts`); this is only the fallback used by
 * tests and any caller that does not go through `config/boot.ts`. */
export const DEFAULT_PORT_CALL_TIMEOUT_MS = 10_000;

/** Constant-time token comparison (spec 3.9: `GATEWAY_TOKEN` "comparación en
 * tiempo constante"). Hashing both sides first sidesteps `timingSafeEqual`
 * throwing on a length mismatch, without leaking the real token's length. */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

export type Message1WithChannel = Message1 & { channel: string };

export type VoucherServiceDeps = {
  voucherLog: VoucherLog;
  signer: SignerPort;
  depositPort: ChannelDepositPort;
  network: string;
  pricePerMibRaw: bigint;
  maxDeltaPerRequestRaw: bigint;
  /** Defaults to `emit()` (stdout only) — same pattern as
   * `server/charge-service.ts`. */
  emit?: (input: EmitInput) => void;
  /** Injectable clock for deterministic `ts`/`signedAt` in tests. */
  now?: () => Date;
  /** Bounds `depositPort.getDepositRaw`/`signer.sign` under the channel lock
   * (review finding, Lote D). @default DEFAULT_PORT_CALL_TIMEOUT_MS */
  portCallTimeoutMs?: number;
};

export type VoucherOutcome = { body: Message2; status: 200 | 503 };

export type VoucherService = {
  handle(m1: Message1WithChannel): Promise<VoucherOutcome>;
};

type PendingEntry = {
  m1: Message1WithChannel;
  resolve: (outcome: VoucherOutcome) => void;
};

type Classified =
  | { kind: "equal"; entry: PendingEntry }
  | { kind: "stale"; entry: PendingEntry }
  | { kind: "exhausted"; entry: PendingEntry }
  | { kind: "rejected"; entry: PendingEntry; detail: string }
  | { kind: "candidate"; entry: PendingEntry; amount: bigint };

function classify(
  entry: PendingEntry,
  previous: VoucherIndexEntry | undefined,
  pricePerMibRaw: bigint,
  maxDeltaPerRequestRaw: bigint,
  depositRaw: bigint,
): Classified {
  const amount = BigInt(entry.m1.cumulativeAmount);
  // With no previous voucher at all there is nothing to be "equal to" or
  // "stale against" (VE-R9/VE-R11 both say "igual/menor al mayor YA
  // FIRMADO") — the very first reading for a channel always falls through
  // to a guardrail-checked signing attempt, whatever its value.
  if (previous !== undefined) {
    if (amount === previous.cumulativeAmountRaw) {
      return { kind: "equal", entry };
    }
    if (amount < previous.cumulativeAmountRaw) {
      return { kind: "stale", entry };
    }
  }
  // CL-R4/2.3.5: the agent cuts first against its cached deposit — signing a
  // voucher above the deposit is signing something the server can never
  // collect. Checked before guardrails so a channel that is simply out of
  // budget is reported as `channel_exhausted` (FT-R4: never logged as an
  // error, never retried), not `amount_rejected`.
  if (amount > depositRaw) {
    return { kind: "exhausted", entry };
  }
  const previousAmountRaw = previous?.cumulativeAmountRaw ?? 0n;
  const guardrailResult = checkGuardrails({
    cumulativeBytes: BigInt(entry.m1.cumulativeBytes),
    cumulativeAmount: amount,
    pricePerMibRaw,
    previousCumulativeAmountRaw: previousAmountRaw,
    maxDeltaPerRequestRaw,
  });
  if (!guardrailResult.ok) {
    return { kind: "rejected", entry, detail: guardrailResult.detail };
  }
  return { kind: "candidate", entry, amount };
}

/**
 * Builds the `POST /vouchers` business logic (T5.3, T5.4): per-channel
 * mutex (VE-R12) with coalescing on top (design 4.3) so that N concurrent
 * readings for the same channel collapse into exactly one signature for the
 * highest cumulative amount in the batch, with every other member of that
 * batch answered `reused: true` against the same voucher — "un vale
 * acumulativo por 150 cubre una lectura de 100".
 */
export function createVoucherService(deps: VoucherServiceDeps): VoucherService {
  const mutex = createChannelMutex();
  const pendingBatches = new Map<string, PendingEntry[]>();
  const emitEvent = deps.emit ?? defaultEmit;
  const now = deps.now ?? (() => new Date());
  const portCallTimeoutMs = deps.portCallTimeoutMs ?? DEFAULT_PORT_CALL_TIMEOUT_MS;

  function resolveEqual(entry: PendingEntry, previous: VoucherIndexEntry, depositRaw: bigint): void {
    const remaining = clampMin0(depositRaw - previous.cumulativeAmountRaw);
    const body = message2SignedSchema.parse({
      version: 1,
      status: "signed",
      sessionId: entry.m1.sessionId,
      channel: entry.m1.channel,
      voucher: {
        cumulativeAmount: previous.cumulativeAmountRaw.toString(),
        signature: previous.signature,
        commitmentPubkey: previous.commitmentPubkey,
        network: deps.network,
      },
      meterReadingId: entry.m1.meterReadingId,
      reused: true,
      remaining: remaining.toString(),
      signedAt: previous.ts,
    });
    entry.resolve({ body, status: 200 });
  }

  function resolveStale(entry: PendingEntry, previous: VoucherIndexEntry, depositRaw: bigint): void {
    const remaining = clampMin0(depositRaw - previous.cumulativeAmountRaw);
    const { body, status } = buildUnsigned("stale_reading", {
      sessionId: entry.m1.sessionId,
      channel: entry.m1.channel,
      remaining: remaining.toString(),
      meterReadingId: entry.m1.meterReadingId,
      detail: `cumulativeAmount ${entry.m1.cumulativeAmount} is lower than the highest signed amount ${previous.cumulativeAmountRaw}`,
    });
    entry.resolve({ body, status });
  }

  function resolveRejected(entry: PendingEntry, detail: string, previousAmountRaw: bigint, depositRaw: bigint): void {
    const remaining = clampMin0(depositRaw - previousAmountRaw);
    const { body, status } = buildUnsigned("amount_rejected", {
      sessionId: entry.m1.sessionId,
      channel: entry.m1.channel,
      remaining: remaining.toString(),
      meterReadingId: entry.m1.meterReadingId,
      detail,
    });
    entry.resolve({ body, status });
  }

  function resolveExhausted(entry: PendingEntry, previousAmountRaw: bigint, depositRaw: bigint): void {
    const remaining = clampMin0(depositRaw - previousAmountRaw);
    const { body, status } = buildUnsigned("channel_exhausted", {
      sessionId: entry.m1.sessionId,
      channel: entry.m1.channel,
      remaining: remaining.toString(),
      meterReadingId: entry.m1.meterReadingId,
      detail: `requested cumulative ${entry.m1.cumulativeAmount} exceeds channel deposit ${depositRaw}`,
    });
    entry.resolve({ body, status });
  }

  function resolveFailure(entry: PendingEntry, reason: Reason, detail: string): void {
    const { body, status } = buildUnsigned(reason, {
      sessionId: entry.m1.sessionId,
      channel: entry.m1.channel,
      meterReadingId: entry.m1.meterReadingId,
      detail,
    });
    entry.resolve({ body, status });
  }

  /**
   * Settles every entry of `batch` still pending once `processBatch` returns
   * or throws (review finding, Lote D, MAJOR): a throw that escapes every
   * inner try/catch below used to leave the corresponding `handle()`
   * promise(s) unsettled forever, since the mutex's own `.finally().catch(()
   * => {})` (`agent/mutex.ts`) exists only to silence the duplicate
   * rejection on its *internal* chain, never to resolve the caller's
   * promise. Concrete trigger this closed: a persisted voucher record whose
   * `ts` predates the tightened schema (see `persistence/voucher-log.ts`)
   * could carry an offset timestamp; replaying it into `previous.ts` and
   * later handing it to `message2SignedSchema.parse` inside `resolveEqual`
   * threw synchronously, mid-classification, with no try/catch around that
   * loop at all.
   *
   * Implementation: wrapping every `entry.resolve` up front means the
   * existing `resolveEqual`/`resolveStale`/`resolveRejected`/`resolveFailure`
   * call sites below need no change to be tracked — whichever one (or the
   * final `entry.resolve({...})` for the signed branch) actually settles an
   * entry removes it from `unresolved` as a side effect.
   */
  async function processBatch(channel: string, batch: PendingEntry[]): Promise<void> {
    const unresolved = new Set<PendingEntry>(batch);
    for (const entry of batch) {
      const settle = entry.resolve;
      entry.resolve = (outcome) => {
        unresolved.delete(entry);
        settle(outcome);
      };
    }

    try {
      let previous: VoucherIndexEntry | undefined;
      let channelInfo: ChannelInfo;
      try {
        previous = deps.voucherLog.getHighest(channel);
        channelInfo = await withTimeout(
          () => deps.depositPort.getChannelInfo(channel),
          portCallTimeoutMs,
          "depositPort.getChannelInfo",
        );
      } catch (error) {
        // Review finding 5, Lote F: `UpstreamRpcError` (config/boot.ts's
        // real `ChannelRpcPort`) marks a genuine Soroban RPC transport
        // failure — distinct from the port's own routine `{status:
        // "not_found"}` for a channel that genuinely does not exist. Mapped
        // to the same retryable `upstream_unavailable` reason a timeout
        // already gets, never the permanent `internal_error`.
        const reason: Reason =
          error instanceof TimeoutError || error instanceof UpstreamRpcError ? "upstream_unavailable" : "internal_error";
        const detail = messageOf(error);
        for (const entry of batch) resolveFailure(entry, reason, detail);
        return;
      }

      // CL-R8/CL-R6: a channel that is not open at all (never deployed, or
      // mid unilateral exit) never reaches guardrails or signing — every
      // entry in the batch gets the same lifecycle reason.
      if (channelInfo.status === "not_found" || channelInfo.status === "not_open" || channelInfo.status === "closing") {
        const reason: Reason =
          channelInfo.status === "closing"
            ? "channel_closing"
            : channelInfo.status === "not_found"
              ? "channel_not_found"
              : "channel_not_open";
        for (const entry of batch) {
          resolveFailure(entry, reason, `channel ${channel} is ${channelInfo.status}`);
        }
        return;
      }

      const depositRaw = channelInfo.depositRaw;
      const previousAmountRaw = previous?.cumulativeAmountRaw ?? 0n;

      const classified = batch.map((entry) =>
        classify(entry, previous, deps.pricePerMibRaw, deps.maxDeltaPerRequestRaw, depositRaw),
      );
      const candidates: Array<{ entry: PendingEntry; amount: bigint }> = [];

      for (const c of classified) {
        if (c.kind === "equal") {
          resolveEqual(c.entry, previous!, depositRaw);
        } else if (c.kind === "stale") {
          resolveStale(c.entry, previous!, depositRaw);
        } else if (c.kind === "exhausted") {
          resolveExhausted(c.entry, previousAmountRaw, depositRaw);
        } else if (c.kind === "rejected") {
          resolveRejected(c.entry, c.detail, previousAmountRaw, depositRaw);
        } else {
          candidates.push({ entry: c.entry, amount: c.amount });
        }
      }

      if (candidates.length === 0) {
        return;
      }

      const winner = candidates.reduce((max, c) => (c.amount > max.amount ? c : max));

      try {
        const signResult = await withTimeout(
          () =>
            deps.signer.sign({
              channel,
              network: deps.network,
              cumulativeAmount: winner.amount.toString(),
              sessionId: winner.entry.m1.sessionId,
              cumulativeBytes: winner.entry.m1.cumulativeBytes,
              meterReadingId: winner.entry.m1.meterReadingId,
            }),
          portCallTimeoutMs,
          "signer.sign",
        );

        const record: VoucherRecord = {
          v: 1,
          ts: now().toISOString(),
          network: deps.network,
          channel,
          sessionId: winner.entry.m1.sessionId,
          cumulativeAmount: winner.amount.toString(),
          cumulativeBytes: winner.entry.m1.cumulativeBytes,
          signature: signResult.signature,
          commitmentPubkey: signResult.commitmentPubkey,
          meterReadingId: winner.entry.m1.meterReadingId,
        };
        // Append + fsync happen inside `append()` — BEFORE any of this
        // batch's responses are sent (VP-R3).
        deps.voucherLog.append(record);

        try {
          // A throwing/misbehaving sink must never turn an already-persisted
          // voucher into a 503 (review finding, Lote D, MINOR): the voucher
          // is durable on disk the moment `append()` above returns, so the
          // event stream's health is never allowed to affect the response.
          emitEvent({
            type: "usage.voucher_signed",
            sessionId: winner.entry.m1.sessionId,
            data: {
              channel,
              cumulativeAmount: record.cumulativeAmount,
              meterReadingId: record.meterReadingId,
            },
          });
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              reason: "usage_voucher_signed_emit_failed",
              detail: messageOf(error),
              channel,
            }),
          );
        }

        const remaining = clampMin0(depositRaw - winner.amount);
        for (const candidate of candidates) {
          const body = message2SignedSchema.parse({
            version: 1,
            status: "signed",
            sessionId: candidate.entry.m1.sessionId,
            channel,
            voucher: {
              cumulativeAmount: record.cumulativeAmount,
              signature: record.signature,
              commitmentPubkey: record.commitmentPubkey,
              network: deps.network,
            },
            meterReadingId: candidate.entry.m1.meterReadingId,
            // Coalescing (design 4.3): only the request that matched the
            // batch's highest amount is the "new" signature; every other
            // candidate — even though its own amount is genuinely new,
            // never stale or equal — is already covered by this higher
            // voucher, so it is answered exactly like VE-R9's idempotent
            // replay: `reused: true`, no extra log line for it.
            reused: candidate !== winner,
            remaining: remaining.toString(),
            signedAt: record.ts,
          });
          candidate.entry.resolve({ body, status: 200 });
        }
      } catch (error) {
        const reason: Reason = error instanceof TimeoutError ? "signer_unavailable" : "internal_error";
        const detail = messageOf(error);
        for (const candidate of candidates) resolveFailure(candidate.entry, reason, detail);
      }
    } catch (error) {
      // Safety net (review finding, Lote D, MAJOR): whatever threw, and
      // wherever, every request in this batch settles instead of hanging
      // `handle()` forever. This should never actually trigger given the
      // catches above — it exists for a failure mode neither one covers
      // (e.g. `classify`/`resolveEqual` throwing on a malformed persisted
      // record, see the doc comment above `unresolved`).
      const detail = messageOf(error);
      console.error(
        JSON.stringify({ level: "error", reason: "voucher_batch_failed_unexpectedly", detail, channel }),
      );
      for (const entry of unresolved) {
        resolveFailure(entry, "internal_error", detail);
      }
    }
  }

  function handle(m1: Message1WithChannel): Promise<VoucherOutcome> {
    return new Promise((resolve) => {
      const entry: PendingEntry = { m1, resolve };
      const existingBatch = pendingBatches.get(m1.channel);
      if (existingBatch !== undefined) {
        // A batch for this channel is already queued behind the mutex
        // (design 4.3: "mientras una firma está en vuelo") — join it
        // instead of starting a separate mutex acquisition.
        existingBatch.push(entry);
        return;
      }
      pendingBatches.set(m1.channel, [entry]);
      void mutex
        .withChannelLock(m1.channel, async () => {
          const batch = pendingBatches.get(m1.channel) ?? [entry];
          pendingBatches.delete(m1.channel);
          await processBatch(m1.channel, batch);
        })
        .catch((error: unknown) => {
          // Defense in depth (review finding, Lote D, MAJOR): `processBatch`
          // now settles every entry itself and never rethrows, so this
          // should be unreachable — but without a `.catch()` here, any
          // future throw between `withChannelLock` and `processBatch` (both
          // synchronous, e.g. `pendingBatches.get`) would again be silently
          // swallowed by the mutex's own `.finally().catch(() => {})`,
          // leaving `handle()` hanging with no log at all.
          console.error(
            JSON.stringify({
              level: "error",
              reason: "voucher_channel_lock_failed_unexpectedly",
              detail: messageOf(error),
              channel: m1.channel,
            }),
          );
        });
    });
  }

  return { handle };
}

export type VouchersRouteDeps = {
  gatewayToken: string;
  /**
   * An already-built `VoucherService` — this HTTP adapter never constructs
   * one itself (`createVoucherService` owns the per-channel mutex/batch
   * state, which must survive across requests; building a fresh service per
   * request, or per route-factory call, would silently break coalescing).
   * Callers either pass the result of `createVoucherService(...)` directly
   * (tests), or a thin wrapper that reads the current instance out of a
   * `FailClosedBoot<VoucherService>` (`agent/app.ts`).
   */
  service: VoucherService;
  /** The configured `CHANNEL_CONTRACT` (stage 2 only — `undefined` on a
   * stage-1-only deployment). Review finding 2, Lote F: M1's own `channel`
   * field used to be trusted as-is, so a wrong value there (bug, stale
   * client cache, or tampering) would silently sign/settle against a
   * different channel than the one the agent/server are actually
   * configured for, zeroing the real settlement. */
  channel?: string;
};

/**
 * `POST /vouchers` (VE-R1, VE-R2, VE-R6, VE-R9, VE-R10, VE-R11, VE-R13).
 * Auth and body-shape failures (`401`, `400`) are plain JSON, not M2
 * envelopes — FT-R5 reserves the M2 vocabulary and its 200/503 split for
 * *business* outcomes, and VE-R1/VE-R2 already specify `401`/`400` directly.
 */
export function createVouchersRoute(deps: VouchersRouteDeps): RequestHandler {
  return async (req: ExpressRequest, res) => {
    const token = req.get("x-gateway-token");
    if (token === undefined || token.length === 0 || !constantTimeEqual(token, deps.gatewayToken)) {
      res.status(401).json({ error: "missing or invalid X-Gateway-Token" });
      return;
    }

    const parsed = message1Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid message1 body", issues: parsed.error.issues });
      return;
    }

    // Review finding 2, Lote F: pin the channel this request signs against
    // to the configured CHANNEL_CONTRACT, never to whatever M1 happens to
    // carry. A present-but-different M1 `channel` is rejected outright
    // (never silently redirected); an absent one falls back to the
    // configured channel (stage 2's only real mode — VE-R5).
    let channel: string;
    if (parsed.data.channel !== undefined) {
      if (deps.channel !== undefined && parsed.data.channel !== deps.channel) {
        const { body, status } = buildUnsigned("channel_not_found", {
          sessionId: parsed.data.sessionId,
          channel: parsed.data.channel,
          meterReadingId: parsed.data.meterReadingId,
          detail: `channel ${parsed.data.channel} does not match the configured channel`,
        });
        res.status(status).json(body);
        return;
      }
      channel = parsed.data.channel;
    } else if (deps.channel !== undefined) {
      channel = deps.channel;
    } else {
      // VE-R5: `channel` is optional in the shared M1 schema (stage 1 charge
      // mode omits it), but every request that reaches this endpoint is
      // stage-2 shaped — POST /vouchers has no other mode.
      res.status(400).json({ error: "channel is required for POST /vouchers (VE-R5)" });
      return;
    }

    const outcome = await deps.service.handle({ ...parsed.data, channel });
    res.status(outcome.status).json(outcome.body);
  };
}
