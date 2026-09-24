// Express <-> Fetch API bridge for the stage 1 charge route (design 4.2).
// Only this file touches Express request/response objects; the actual
// charge logic (`charge-service.ts`) speaks Fetch API `Request`/`Response`
// only (what `@stellar/mpp`'s server methods expect), so it stays reusable
// if the transport ever changes and stays trivially testable without
// spinning up Express at all.

import type { Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from "express";
import { computeChargeDeltaRaw, parseNonNegativeIntegerRaw } from "../../shared/money.ts";
import type { EmitInput } from "../../shared/events.ts";
import { buildUnsigned } from "../../shared/messages.ts";
import { createChargeService, type ChargePort } from "../charge-service.ts";

export type ChargeRouteDeps = {
  chargePort: ChargePort;
  network: string;
  explorerBaseUrl: string;
  pricePerMibRaw: bigint;
  /** Defaults to `emit()` (stdout only) — `app.ts` passes the
   * webhook-enabled emitter from `createEventEmitter()` (T4.2) when
   * `BACKEND_EVENTS_URL` is configured. */
  emit?: (input: EmitInput) => void;
};

/**
 * Demo-scoped "simulated consumption" tracker (S1-R5; spec 3.1 scenario
 * "cobros repetidos contra consumo simulado"): keyed by session id so a
 * repeated call against the same session is billed by delta
 * (`cumulative(now) - cumulative(previous)`), never by the full running
 * total (AC-R4). Deliberately in-memory and per-process — a real user/session
 * store is explicitly out of scope (OS-R4); this is request correlation for
 * one demo, not a user base.
 */
export type CumulativeBytesStore = {
  get(sessionId: string): bigint | undefined;
  set(sessionId: string, cumulativeBytes: bigint): void;
};

export function createInMemoryCumulativeBytesStore(): CumulativeBytesStore {
  const state = new Map<string, bigint>();
  return {
    get: (sessionId) => state.get(sessionId),
    set: (sessionId, cumulativeBytes) => {
      state.set(sessionId, cumulativeBytes);
    },
  };
}

const DEFAULT_SESSION_KEY = "default";
// Flat 1 MiB for a bare `curl -i` demo call with no query params at all
// (checklist item §14.1: "servidor devuelve 402 sin cliente").
const DEFAULT_CUMULATIVE_BYTES = 1_048_576n;

function toFetchRequest(req: ExpressRequest): Request {
  const host = req.get("host") ?? "localhost";
  const url = `${req.protocol}://${host}${req.originalUrl}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
  });
}

async function sendFetchResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => {
    // content-length would be stale once re-sent through Express — Express
    // recomputes it from the body we pass to res.send().
    if (name.toLowerCase() === "content-length") return;
    res.setHeader(name, value);
  });
  res.send(await response.text());
}

/**
 * `GET /paid-resource` — the stage 1 charge route (S1-R1). Accepts optional
 * `sessionId` and `cumulativeBytes` query params to exercise the "repeated
 * charges" scenario; a bare call with neither is billed a flat 1 MiB.
 */
export function createChargeRoute(
  deps: ChargeRouteDeps,
  cumulativeBytesStore: CumulativeBytesStore = createInMemoryCumulativeBytesStore(),
): RequestHandler {
  const handleCharge = createChargeService({
    chargePort: deps.chargePort,
    network: deps.network,
    explorerBaseUrl: deps.explorerBaseUrl,
    ...(deps.emit !== undefined ? { emit: deps.emit } : {}),
  });

  return async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    const storeKey = sessionId ?? DEFAULT_SESSION_KEY;
    const cumulativeBytesParam = req.query.cumulativeBytes;
    let cumulativeBytesNow: bigint;
    if (typeof cumulativeBytesParam === "string") {
      // Review finding, Lote D (MAJOR): `BigInt(cumulativeBytesParam)` used
      // to throw a raw `SyntaxError` on malformed input (e.g. `?cumulative
      // Bytes=abc`), which — with no error handler on this app (see
      // `server/app.ts`) — surfaced as Express's default HTML 500 page,
      // leaking absolute file paths in the stack trace. `?cumulativeBytes=`
      // must be a non-negative integer string; anything else is a plain 400.
      const parsed = parseNonNegativeIntegerRaw(cumulativeBytesParam);
      if (parsed === undefined) {
        res.status(400).json({ error: "cumulativeBytes must be a non-negative integer" });
        return;
      }
      cumulativeBytesNow = parsed;
    } else {
      cumulativeBytesNow = DEFAULT_CUMULATIVE_BYTES;
    }
    const cumulativeBytesPrevious = cumulativeBytesStore.get(storeKey) ?? 0n;

    if (cumulativeBytesNow <= cumulativeBytesPrevious) {
      // Review findings, Lote D (MAJOR x2): a lower reading used to reach
      // `computeChargeDeltaRaw`, which throws a `RangeError` for a
      // regression — another uncaught-exception 500. An *equal* reading
      // (e.g. the same `?cumulativeBytes=` requested twice in a row, the
      // exact repeated-`GET /paid-resource` scenario from the testnet
      // runbook) computes `amountRaw = 0n`, which the SDK client rejects
      // with `Invalid amount: "0"` — also an uncaught throw. Both are the
      // same business outcome: nothing new to bill (FT-R6), never a charge
      // attempt and never a 402 challenge.
      const { body, status } = buildUnsigned("stale_reading", {
        sessionId,
        remaining: "0",
        meterReadingId: null,
        detail: `cumulativeBytes ${cumulativeBytesNow} is not greater than the last billed value ${cumulativeBytesPrevious}`,
      });
      res.status(status).json(body);
      return;
    }
    const amountRaw = computeChargeDeltaRaw(
      cumulativeBytesNow,
      cumulativeBytesPrevious,
      deps.pricePerMibRaw,
    );

    const fetchRequest = toFetchRequest(req);
    const { response, settled } = await handleCharge(fetchRequest, {
      sessionId,
      amountRaw: amountRaw.toString(),
      description: "payments-mpp stage 1 charge",
    });

    // Only a real settlement advances this session's simulated consumption —
    // never a 402 challenge and never a failed charge, even one mapped to
    // HTTP 200 (FT-R6). `settled` (not `response.status`) is what tells them
    // apart; see charge-service.ts's ChargeResult doc comment.
    if (settled) {
      cumulativeBytesStore.set(storeKey, cumulativeBytesNow);
    }

    await sendFetchResponse(res, response);
  };
}
