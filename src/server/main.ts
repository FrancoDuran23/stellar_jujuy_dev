// Payment server entrypoint (`npm run server`; design 4.5, 4.6; FC-R1).
//
// Order that must never move (D7, FC-R1): load env -> `app.listen()` ->
// build the payment instance. The port accepts connections before the
// Stellar/mppx SDK is ever touched, so a bad RPC or a malformed secret never
// prevents the process from starting.

import "dotenv/config";
import { createServerBoot } from "../config/boot.ts";
import { parseServerEnv } from "../config/env.ts";
import { createEventEmitter, createWebhookSink } from "../shared/events.ts";
import { createServerApp } from "./app.ts";

const DEFAULT_PORT = 8080;
const DEFAULT_NETWORK = "stellar:testnet";
const DEFAULT_EXPLORER_BASE_URL = "https://stellar.expert/explorer/testnet";

// A single parse at startup. If it fails, `port`/`network`/`explorerBaseUrl`
// fall back to their documented defaults so `listen()` still succeeds
// (FC-R1) — the real failure is reported by `/ready` once `boot.ensureReady()`
// parses the same env again inside its own try/catch and finds the same
// problem, this time with `unavailable`/`config_invalid` and a named
// variable (CF-R3).
const parsedAtStartup = parseServerEnv(process.env);
const port = parsedAtStartup.ok ? parsedAtStartup.value.PORT : DEFAULT_PORT;
const network = parsedAtStartup.ok ? parsedAtStartup.value.STELLAR_NETWORK : DEFAULT_NETWORK;
const explorerBaseUrl = parsedAtStartup.ok
  ? parsedAtStartup.value.EXPLORER_BASE_URL
  : DEFAULT_EXPLORER_BASE_URL;
const pricePerMibRaw = parsedAtStartup.ok ? parsedAtStartup.value.PRICE_PER_MIB_RAW : 0n;

// EV-R4: webhook delivery is additive and optional — stdout emission (EV-R1)
// never depends on it.
const webhookSink =
  parsedAtStartup.ok && parsedAtStartup.value.BACKEND_EVENTS_URL !== undefined
    ? createWebhookSink({ url: parsedAtStartup.value.BACKEND_EVENTS_URL })
    : undefined;
const emitEvent = createEventEmitter(webhookSink);

const boot = createServerBoot();
const app = createServerApp({ boot, network, explorerBaseUrl, pricePerMibRaw, emit: emitEvent });

app.listen(port, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", msg: `payments-mpp server listening on :${port}` })}\n`,
  );
  // FC-R1: the payment instance is built only after the port already
  // accepts connections.
  void boot.ensureReady();
});
