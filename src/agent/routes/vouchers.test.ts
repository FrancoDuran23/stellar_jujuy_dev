// T5.3 (idempotency, auth, schema) + T5.4 (concurrency and coalescing).
// Business-logic tests call `createVoucherService` directly with
// `Promise.all(...)` for true same-tick concurrency (see the doc comment at
// the top of vouchers.ts for why real HTTP would be racy for that). HTTP
// adapter tests (auth, schema, channel-required) go through a real Express
// app + real sockets, matching the rest of this codebase's route tests.
//
// Persistence is never mocked (design 4.7): every test opens a real
// `VoucherLog` against a temp directory created with `fs.mkdtempSync`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { VoucherLog, type VoucherRecord } from "../../persistence/voucher-log.ts";
import { createFakeSigner, type SignerPort } from "../signer.ts";
import {
  createStaticDepositPort,
  createVoucherService,
  createVouchersRoute,
  type ChannelDepositPort,
  type Message1WithChannel,
  type VoucherService,
  type VoucherServiceDeps,
} from "./vouchers.ts";

const NETWORK = "stellar:testnet";
const CHANNEL = `C${"A".repeat(55)}`;
const PRICE_PER_MIB_RAW = 10_000n;
const MAX_DELTA_PER_REQUEST_RAW = 5_000_000n;
const GATEWAY_TOKEN = "test-gateway-token";
const MIB = 1_048_576n;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vouchers-route-test-"));
}

function openVoucherLog(): VoucherLog {
  const dir = makeTempDir();
  const opened = VoucherLog.open(path.join(dir, "vouchers-agent-testnet.jsonl"));
  assert.equal(opened.status, "ok");
  if (opened.status !== "ok") throw new Error("unreachable");
  return opened.log;
}

function makeService(overrides: Partial<VoucherServiceDeps> = {}): VoucherService {
  return createVoucherService({
    voucherLog: overrides.voucherLog ?? openVoucherLog(),
    signer: overrides.signer ?? createFakeSigner(),
    depositPort: overrides.depositPort ?? createStaticDepositPort(),
    network: overrides.network ?? NETWORK,
    pricePerMibRaw: overrides.pricePerMibRaw ?? PRICE_PER_MIB_RAW,
    maxDeltaPerRequestRaw: overrides.maxDeltaPerRequestRaw ?? MAX_DELTA_PER_REQUEST_RAW,
    ...(overrides.emit !== undefined ? { emit: overrides.emit } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.portCallTimeoutMs !== undefined ? { portCallTimeoutMs: overrides.portCallTimeoutMs } : {}),
  });
}

type M1Overrides = Omit<Partial<Message1WithChannel>, "cumulativeBytes"> & {
  /** Accepts a bigint for readability at call sites doing bigint math;
   * converted to the schema's `number` at the end. */
  cumulativeBytes?: bigint;
};

function m1(overrides: M1Overrides = {}): Message1WithChannel {
  const cumulativeBytes = overrides.cumulativeBytes ?? MIB;
  return {
    version: 1,
    sessionId: overrides.sessionId ?? "sess_1",
    channel: overrides.channel ?? CHANNEL,
    network: overrides.network ?? NETWORK,
    asset: "USDC",
    cumulativeBytes: Number(cumulativeBytes),
    cumulativeAmount: overrides.cumulativeAmount ?? PRICE_PER_MIB_RAW.toString(),
    meterReadingId: overrides.meterReadingId ?? "mr_1",
    observedAt: overrides.observedAt ?? "2026-09-20T18:04:02.118Z",
  };
}

// --- T5.3: idempotency table (VE-R9, VE-R10, VE-R11) + guardrails (AC-R3, AC-R7) ---

test("first reading for a channel signs a new voucher (VE-R10) and persists it before resolving (VP-R3)", async () => {
  const voucherLog = openVoucherLog();
  const service = makeService({ voucherLog });

  const outcome = await service.handle(m1({ meterReadingId: "mr_1" }));
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.status, "signed");
  if (outcome.body.status !== "signed") return;
  assert.equal(outcome.body.reused, false);
  assert.equal(outcome.body.voucher.cumulativeAmount, PRICE_PER_MIB_RAW.toString());

  // Already on disk, fsynced, before handle() resolved.
  const highest = voucherLog.getHighest(CHANNEL);
  assert.ok(highest);
  assert.equal(highest!.cumulativeAmountRaw, PRICE_PER_MIB_RAW);
  assert.equal(highest!.signature, outcome.body.voucher.signature);
});

test("an equal reading is idempotent: same signature, reused:true, no new log line (VE-R9)", async () => {
  const voucherLog = openVoucherLog();
  const service = makeService({ voucherLog });

  const first = await service.handle(m1({ meterReadingId: "mr_1" }));
  assert.equal(first.body.status, "signed");
  if (first.body.status !== "signed") return;

  const before = fs.readFileSync(voucherLog.path, "utf8");
  const second = await service.handle(m1({ meterReadingId: "mr_2" })); // gateway retry, same amount
  const after = fs.readFileSync(voucherLog.path, "utf8");

  assert.equal(second.status, 200);
  assert.equal(second.body.status, "signed");
  if (second.body.status !== "signed") return;
  assert.equal(second.body.reused, true);
  assert.equal(second.body.voucher.signature, first.body.voucher.signature);
  assert.equal(after, before, "no new line must be written for a reused voucher");
});

test("a higher reading supersedes the previous voucher (VE-R10)", async () => {
  const voucherLog = openVoucherLog();
  const service = makeService({ voucherLog });

  const first = await service.handle(m1({ cumulativeBytes: MIB, cumulativeAmount: "10000" }));
  assert.equal(first.body.status, "signed");

  const higherBytes = MIB * 2n;
  const higherAmount = PRICE_PER_MIB_RAW * 2n;
  const second = await service.handle(
    m1({ cumulativeBytes: higherBytes, cumulativeAmount: higherAmount.toString() }),
  );
  assert.equal(second.body.status, "signed");
  if (second.body.status !== "signed") return;
  assert.equal(second.body.reused, false);
  assert.equal(second.body.voucher.cumulativeAmount, higherAmount.toString());
  assert.equal(voucherLog.getHighest(CHANNEL)!.cumulativeAmountRaw, higherAmount);
});

test("a lower reading is rejected as stale_reading, retryable:false, nothing signed (VE-R11)", async () => {
  const voucherLog = openVoucherLog();
  const service = makeService({ voucherLog });

  await service.handle(m1({ cumulativeBytes: MIB * 2n, cumulativeAmount: (PRICE_PER_MIB_RAW * 2n).toString() }));
  const before = fs.readFileSync(voucherLog.path, "utf8");

  const stale = await service.handle(m1({ cumulativeBytes: MIB, cumulativeAmount: PRICE_PER_MIB_RAW.toString() }));
  const after = fs.readFileSync(voucherLog.path, "utf8");

  assert.equal(stale.status, 200);
  assert.equal(stale.body.status, "unsigned");
  if (stale.body.status !== "unsigned") return;
  assert.equal(stale.body.reason, "stale_reading");
  assert.equal(stale.body.retryable, false);
  assert.equal(after, before, "a stale reading must never append a log line");
});

test("a reading whose recomputed amount disagrees with cumulativeAmount is amount_rejected (AC-R2/AC-R3)", async () => {
  const service = makeService();
  const outcome = await service.handle(m1({ cumulativeBytes: MIB, cumulativeAmount: "1" }));
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.status, "unsigned");
  if (outcome.body.status !== "unsigned") return;
  assert.equal(outcome.body.reason, "amount_rejected");
  assert.equal(outcome.body.retryable, false);
});

test("a reading whose delta exceeds MAX_DELTA_PER_REQUEST_RAW is amount_rejected (AC-R7)", async () => {
  const service = makeService({ maxDeltaPerRequestRaw: 1_000n });
  const bytes = MIB * 10n; // consistent amount, but the delta itself is too large
  const amount = PRICE_PER_MIB_RAW * 10n;
  const outcome = await service.handle(m1({ cumulativeBytes: bytes, cumulativeAmount: amount.toString() }));
  assert.equal(outcome.body.status, "unsigned");
  if (outcome.body.status !== "unsigned") return;
  assert.equal(outcome.body.reason, "amount_rejected");
});

test("remaining is computed from the channel deposit", async () => {
  const depositRaw = 1_000_000n;
  const service = makeService({ depositPort: createStaticDepositPort(depositRaw) });
  const outcome = await service.handle(m1({ cumulativeBytes: MIB, cumulativeAmount: "10000" }));
  assert.equal(outcome.body.status, "signed");
  if (outcome.body.status !== "signed") return;
  assert.equal(outcome.body.remaining, (depositRaw - 10_000n).toString());
});

test("an unexpected signer failure maps to internal_error, retryable:true (never an uncaught rejection)", async () => {
  const failingSigner: SignerPort = {
    async sign() {
      throw new Error("signer exploded");
    },
  };
  const service = makeService({ signer: failingSigner });
  const outcome = await service.handle(m1());
  assert.equal(outcome.status, 503);
  assert.equal(outcome.body.status, "unsigned");
  if (outcome.body.status !== "unsigned") return;
  assert.equal(outcome.body.reason, "internal_error");
  assert.equal(outcome.body.retryable, true);
});

// --- T5.4: concurrency and coalescing (VE-R12, design 4.3) ---

test("N concurrent readings for the same channel collapse into one signature for the highest, the rest reused:true", async () => {
  const voucherLog = openVoucherLog();
  let signCalls = 0;
  const inner = createFakeSigner();
  const countingSigner: SignerPort = {
    async sign(input) {
      signCalls += 1;
      return inner.sign(input);
    },
  };
  const service = makeService({ voucherLog, signer: countingSigner });

  const amounts = [10_000n, 30_000n, 20_000n]; // arrival order deliberately not sorted
  const requests = amounts.map((amount) =>
    m1({
      cumulativeBytes: (amount * MIB) / PRICE_PER_MIB_RAW,
      cumulativeAmount: amount.toString(),
      meterReadingId: `mr_${amount}`,
    }),
  );

  // Issued in the same synchronous tick so they land in one coalesced batch.
  const outcomes = await Promise.all(requests.map((request) => service.handle(request)));

  assert.equal(signCalls, 1, "exactly one signature must be produced for the whole batch");

  const signed = outcomes.map((outcome) => {
    assert.equal(outcome.body.status, "signed");
    if (outcome.body.status !== "signed") throw new Error("unreachable");
    return outcome.body;
  });

  const maxAmount = (30_000n).toString();
  for (const [index, body] of signed.entries()) {
    assert.equal(body.voucher.cumulativeAmount, maxAmount, `entry ${index} must reflect the batch's highest amount`);
  }
  const reusedFlags = signed.map((body) => body.reused).sort();
  assert.deepEqual(reusedFlags, [false, true, true], "exactly one winner (reused:false), the rest reused:true");

  // Exactly one new line was appended for the whole batch.
  const lines = fs.readFileSync(voucherLog.path, "utf8").split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  assert.equal(voucherLog.getHighest(CHANNEL)!.cumulativeAmountRaw, 30_000n);
});

test("concurrent readings on different channels are never coalesced together", async () => {
  const voucherLog = openVoucherLog();
  const service = makeService({ voucherLog });
  const channelA = `C${"A".repeat(55)}`;
  const channelB = `C${"B".repeat(55)}`;

  const [outcomeA, outcomeB] = await Promise.all([
    service.handle(m1({ channel: channelA, cumulativeBytes: MIB, cumulativeAmount: "10000", meterReadingId: "a" })),
    service.handle(m1({ channel: channelB, cumulativeBytes: MIB * 2n, cumulativeAmount: "20000", meterReadingId: "b" })),
  ]);

  assert.equal(outcomeA.body.status, "signed");
  assert.equal(outcomeB.body.status, "signed");
  if (outcomeA.body.status !== "signed" || outcomeB.body.status !== "signed") return;
  assert.equal(outcomeA.body.reused, false);
  assert.equal(outcomeB.body.reused, false);
  assert.equal(voucherLog.getHighest(channelA)!.cumulativeAmountRaw, 10_000n);
  assert.equal(voucherLog.getHighest(channelB)!.cumulativeAmountRaw, 20_000n);
});

test("a stale reading concurrent with a valid higher reading is still reported stale, independent of coalescing", async () => {
  const voucherLog = openVoucherLog();
  const service = makeService({ voucherLog });

  // Establish a baseline first.
  await service.handle(m1({ cumulativeBytes: MIB * 5n, cumulativeAmount: (PRICE_PER_MIB_RAW * 5n).toString() }));

  const [staleOutcome, higherOutcome] = await Promise.all([
    service.handle(m1({ cumulativeBytes: MIB * 2n, cumulativeAmount: (PRICE_PER_MIB_RAW * 2n).toString() })),
    service.handle(m1({ cumulativeBytes: MIB * 8n, cumulativeAmount: (PRICE_PER_MIB_RAW * 8n).toString() })),
  ]);

  assert.equal(staleOutcome.body.status, "unsigned");
  if (staleOutcome.body.status === "unsigned") {
    assert.equal(staleOutcome.body.reason, "stale_reading");
  }
  assert.equal(higherOutcome.body.status, "signed");
});

// --- Review findings, Lote D: processBatch always settles, timeouts, and
// event-sink isolation ---

test("a throw during classification (malformed persisted ts) settles 503 internal_error instead of hanging, and releases the lock (review finding 1)", async () => {
  const voucherLog = openVoucherLog();
  // Simulates a record persisted before the `ts` schema was tightened
  // (`persistence/voucher-log.ts`): `append()` itself never validates its
  // argument, so this reaches the in-memory index exactly like a replayed
  // pre-existing line with the previously-accepted "any non-empty string"
  // shape would. An offset timestamp is accepted by `voucherRecordSchema`
  // before the fix but rejected by `message2SignedSchema.signedAt`
  // (`z.iso.datetime()`, no offset) — so `resolveEqual`'s `.parse()` used to
  // throw synchronously, mid-batch, with nothing to catch it.
  const badTs = "2026-09-20T18:04:02.118+02:00";
  const record: VoucherRecord = {
    v: 1,
    ts: badTs,
    network: NETWORK,
    channel: CHANNEL,
    sessionId: "sess_prev",
    cumulativeAmount: PRICE_PER_MIB_RAW.toString(),
    cumulativeBytes: Number(MIB),
    signature: "a".repeat(128),
    commitmentPubkey: "b".repeat(64),
    meterReadingId: "mr_prev",
  };
  voucherLog.append(record);

  const service = makeService({ voucherLog });
  // Same cumulativeAmount as the corrupt record above -> classified "equal"
  // -> resolveEqual -> message2SignedSchema.parse({ signedAt: badTs }) throws.
  const outcome = await service.handle(m1({ cumulativeAmount: PRICE_PER_MIB_RAW.toString(), meterReadingId: "mr_next" }));
  assert.equal(outcome.status, 503);
  assert.equal(outcome.body.status, "unsigned");
  if (outcome.body.status !== "unsigned") return;
  assert.equal(outcome.body.reason, "internal_error");
  assert.equal(outcome.body.retryable, true);

  // The lock must be released: a normal higher reading on the same channel
  // still works right after.
  const next = await service.handle(
    m1({ cumulativeBytes: MIB * 2n, cumulativeAmount: (PRICE_PER_MIB_RAW * 2n).toString(), meterReadingId: "mr_after" }),
  );
  assert.equal(next.body.status, "signed");
});

test("a hanging depositPort.getDepositRaw times out as upstream_unavailable and releases the lock (review finding 7)", async () => {
  const hangingDepositPort: ChannelDepositPort = {
    getDepositRaw: () => new Promise(() => {}),
  };
  const service = makeService({ depositPort: hangingDepositPort, portCallTimeoutMs: 20 });

  const first = await service.handle(m1({ meterReadingId: "mr_1" }));
  assert.equal(first.status, 503);
  if (first.body.status !== "unsigned") throw new Error("unreachable");
  assert.equal(first.body.reason, "upstream_unavailable");
  assert.equal(first.body.retryable, true);

  // If the mutex failed to release after the timeout this would hang forever
  // instead of settling.
  const second = await service.handle(m1({ meterReadingId: "mr_2" }));
  assert.equal(second.status, 503);
});

test("a hanging signer.sign times out as signer_unavailable instead of hanging the response (review finding 7)", async () => {
  const hangingSigner: SignerPort = { sign: () => new Promise(() => {}) };
  const service = makeService({ signer: hangingSigner, portCallTimeoutMs: 20 });

  const outcome = await service.handle(m1());
  assert.equal(outcome.status, 503);
  if (outcome.body.status !== "unsigned") throw new Error("unreachable");
  assert.equal(outcome.body.reason, "signer_unavailable");
  assert.equal(outcome.body.retryable, true);
});

test("a throwing event sink never turns an already-persisted voucher into a 503 (review finding 6)", async () => {
  const voucherLog = openVoucherLog();
  const throwingEmit: VoucherServiceDeps["emit"] = () => {
    throw new Error("sink exploded");
  };
  const service = makeService({ voucherLog, emit: throwingEmit });

  const outcome = await service.handle(m1());
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.status, "signed");
  assert.ok(voucherLog.getHighest(CHANNEL), "the voucher must still be persisted");
});

test("append (fsync included) happens before handle() resolves (VP-R3, review finding 8)", async () => {
  const voucherLog = openVoucherLog();
  const callOrder: string[] = [];
  const originalAppend = voucherLog.append.bind(voucherLog);
  const spyLog = new Proxy(voucherLog, {
    get(target, prop, receiver) {
      if (prop === "append") {
        return (record: VoucherRecord) => {
          callOrder.push("append");
          originalAppend(record);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as VoucherLog;

  const service = makeService({ voucherLog: spyLog });
  const outcome = await service.handle(m1());
  callOrder.push("resolved");

  assert.equal(outcome.body.status, "signed");
  assert.deepEqual(callOrder, ["append", "resolved"]);
});

// --- HTTP adapter: auth, schema validation, channel-required (VE-R1, VE-R2, VE-R5) ---

async function withRouteApp(
  service: VoucherService,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post("/vouchers", createVouchersRoute({ gatewayToken: GATEWAY_TOKEN, service }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("POST /vouchers without X-Gateway-Token is 401 (VE-R1)", async () => {
  const service = makeService();
  await withRouteApp(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(m1()),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /vouchers with the wrong X-Gateway-Token is 401 (VE-R1)", async () => {
  const service = makeService();
  await withRouteApp(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": "wrong-token" },
      body: JSON.stringify(m1()),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /vouchers with a malformed body is 400 and never signs (VE-R2)", async () => {
  const service = makeService();
  await withRouteApp(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": GATEWAY_TOKEN },
      body: JSON.stringify({ version: 1 }), // missing everything else
    });
    assert.equal(response.status, 400);
  });
});

test("POST /vouchers without a channel is 400 (VE-R5: channel is required for this endpoint)", async () => {
  const service = makeService();
  await withRouteApp(service, async (baseUrl) => {
    const { channel: _channel, ...withoutChannel } = m1();
    const response = await fetch(`${baseUrl}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": GATEWAY_TOKEN },
      body: JSON.stringify(withoutChannel),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /vouchers with a valid token and body signs and returns 200 (end-to-end HTTP)", async () => {
  const service = makeService();
  await withRouteApp(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": GATEWAY_TOKEN },
      body: JSON.stringify(m1()),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "signed");
  });
});
