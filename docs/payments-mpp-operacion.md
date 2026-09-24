# payments-mpp — guía de operación

> Guía operativa del componente de pagos (antes era el README del repo). La visión del producto y las decisiones de arquitectura están en el [README](../README.md).

Micropayment component for the connectivity product: a `server` (recipient)
and an `agent` (funder) that meter and settle Stellar/Soroban payments so the
gateway/meter can bill by bytes consumed. Full requirements and design live in
`docs/sdd/payments-mpp.md`.

## Status

Stage 1 (sponsored charge server + headless agent client), stage 1.5
(`POST /vouchers` against simulated consumption), and stage 2 (payment
channel: open/top-up/close-start/refund, real commitment signing and
verification, close with trustline check and balance-delta assertion,
close_start dispute monitor) are all implemented and verified live against
testnet (`docs/sdd/payments-mpp.md` §6, "Lote E"). One known gap: no
`settle` (periodic partial withdrawal) — the only wasm revision deployable
today has no `settle` function; the recipient collects only by closing the
channel. Building the current `main` branch of `one-way-channel` (which has
`settle`) needs a Rust + `wasm32v1-none` + `stellar` CLI toolchain, not
available in this environment.

## Running it

- `npm run server` — starts the payment server on `PORT` (default `8080`).
  `GET /health` and `GET /ready` are always reachable; `GET /paid-resource`
  is fail-closed behind `/ready`.
- `npm run agent` — one-shot CLI: makes exactly one paid request against
  `PAYMENT_SERVER_URL` and exits (stage 1, S1-R7 evidence). Exits `0` on a
  settled payment and on a non-retryable M2 outcome (e.g. `stale_reading` —
  "nothing new to bill"); exits `1` on a retryable M2 outcome (e.g. `503
  signer_unavailable`) or a technical/network failure. Never prints a stack
  trace.
  - `--bytes <n>` sets the cumulative bytes value sent as
    `?cumulativeBytes=`; falls back to the `CUMULATIVE_BYTES` env var, then
    to `1048576` (1 MiB, matching the server's own bare-call default). Must
    be a non-negative integer (same rule as the server's `?cumulativeBytes=`
    below). Example: `npm run agent -- --bytes 2097152`.
- `npm run agent:serve` — long-running agent process: listens on
  `AGENT_PORT` (default `8081`) and serves `GET /health`, `GET /ready`, and
  `POST /vouchers` (stage 1.5).
- `?cumulativeBytes=<n>` on `GET /paid-resource` sets the simulated
  cumulative consumption for the request's session (`?sessionId=`, default
  session otherwise); the charge is always the delta against the last value
  billed for that session. A value that is not a non-negative integer is a
  400; a value that does not advance past the last billed one (including a
  repeat of the same value) is a 200 M2 `stale_reading` — no charge attempt.

### Stage 2 (payment channel)

Requires `CHANNEL_CONTRACT` set (the stage-2 switch — see `.env.example`):
the server also then requires `COMMITMENT_PUBKEY`/`FUNDER_ACCOUNT`, the
agent also requires `COMMITMENT_SECRET`.

Both channel CLIs below (`agent/channel.ts`, `server/channel-admin.ts`) are
testnet-only demo tools — every subcommand refuses to run at all when
`STELLAR_NETWORK=stellar:pubnet`, so a copy-pasted `.env` can never move
real funds through them (`docs/sdd/payments-mpp.md` §6, "Lote F", finding
10b).

- `npm run channel:open -- --deposit <raw> [--waiting-period <ledgers>]` —
  funder-side: deploys a new channel instance (`createCustomContract`
  against the shared testnet wasm), prints `CHANNEL_CONTRACT=`/
  `COMMITMENT_PUBKEY=`/`FUNDER_ACCOUNT=` to paste into `.env` (never a
  secret), and writes `data/channel-{network}.json` (the deposit record of
  truth — the deployed wasm has no `deposited()` getter).
- `npm run channel:top-up -- --amount <raw>` — funder-side top-up. Updates
  the existing local deposit record, or seeds a fresh one (with a
  documented `0` placeholder for `refundWaitingPeriodLedgers`/
  `deployLedger`, which nothing reads back) when the channel was opened
  outside this CLI and no local record exists yet — the deposit is never
  silently dropped.
- `npm run channel:close-start` / `npm run channel:refund` — funder's
  unilateral exit (waits `refund_waiting_period` ledgers between the two).
- `npm run channel:state` — prints the contract getters, on-chain dispute
  state (`closeEffectiveAtLedger`/`pendingDispute`), from the funder's view.
- Once `npm run server` is running with stage 2 configured, it also serves
  `POST /channel/vouchers` (internal, agent-only — never called by the
  gateway; rejects a `channel` that does not match the configured
  `CHANNEL_CONTRACT` with a 400) and runs the close_start dispute monitor
  (`CHANNEL_POLL_INTERVAL_MS`, default 30s, plus a `watchChannel()`-backed
  near-real-time watch, backed up by a poll-to-poll balance-drop signal);
  `/ready` gains `stage: 2`, the channel id, and the monitor's last known
  state/error, and now fails (503) if the channel instance is not ready or
  its monitor is not running.
- `npm run channel-admin:state` / `npm run channel-admin:close` —
  recipient/operator side: read the channel's state (including the
  server's own highest accepted commitment) or close it on purpose (the
  same trustline check + balance-delta assertion the dispute monitor uses).
- `npm run agent:serve`'s `POST /vouchers` pins every request to the
  configured `CHANNEL_CONTRACT` (a different `channel` in the request is
  rejected unsigned, never silently redirected) and signs and, once
  `CHANNEL_CONTRACT`/`COMMITMENT_SECRET` are set, also delivers the signed
  commitment to the payment server before acknowledging the gateway
  (`reason` can be `channel_exhausted`/`channel_closing`/
  `channel_not_found`/`channel_not_open` in addition to the stage-1
  reasons — a `channel` in the request that does not match the configured
  `CHANNEL_CONTRACT` is also `channel_not_found`, never silently redirected
  — see `docs/sdd/payments-mpp.md` §3.7).

## Quick path

1. Install Node `>=22.18` (type stripping runs `.ts` files directly — no
   build step). Confirm with `node --version`. Older Node: prefix scripts
   with `node --experimental-strip-types`.
2. `npm install`
3. `npm run verify:deps` — fails if `@stellar/stellar-sdk` or `mppx` resolve
   to more than one version (issue #70 regression guard).
4. `cp .env.example .env` and fill in every empty value (see comments in the
   file for what each one does and which stage requires it).
5. `npm run check` — `tsc --noEmit`, must be clean.
6. `npm test` — `node --test`, must be all green.

## Details

| Topic | Decision |
|-------|----------|
| Language | TypeScript, executed directly by Node's built-in type stripping. No `tsc` build step; `npm run check` only type-checks. |
| Module boundaries | One npm package, folder-enforced boundaries: `shared/` has zero knowledge of `agent/`, `server/`, or `persistence/`. Channel CLIs live at `agent/channel.ts` (funder) and `server/channel-admin.ts` (operator), not a separate top-level `cli/` folder. See `docs/sdd/payments-mpp.md` §4.1 and §6 "Lote E". |
| Testing | `node:test` + `node:assert/strict`, no test framework dependency. SDK and RPC calls are mocked through explicit ports (`ChannelPort`, `RpcPort`, `ChargePort`, `TrustlinePort`); disk persistence is never mocked — those tests write to a real `fs.mkdtemp` directory. |
| Dependency pins | Every dependency is pinned exactly (no `^`/`~`). `npm run verify:deps` enforces a single resolved copy of `@stellar/stellar-sdk` and `mppx`. |
| Money | All amounts are raw-unit strings handled as `BigInt`. Never `Number`, never floating point. |
| Windows | Scripts are plain Node (`scripts/verify-deps.mjs`), not shell one-liners — the team develops on Windows, where `> /dev/null` and unquoted globs behave differently than in bash. |

## Checklist

- [ ] `npm install` completes without `--legacy-peer-deps`
- [ ] `npm run verify:deps` reports a single resolved version for every pinned package
- [ ] `.env` exists locally and is never committed
- [ ] `npm run check` passes
- [ ] `npm test` passes

## Next step

**T8.2 is closed** (2026-09-15): two real, sponsored testnet charges settled
end-to-end (fee payer = recipient, agent XLM balance unchanged). Evidence,
both transaction hashes, and balances before/after are in
`docs/sdd/payments-mpp.md` §6, "T8.2 — evidencia testnet".

**Escalón 2 (WU6/WU7) is closed** (2026-09-16, "Lote E"): channel open/
top-up/close-start/refund, real commitment signing/verification, and close
with a trustline check + balance-delta assertion, all verified live against
testnet — full M1→M2 loop against the demo channel (`reused`/`stale_reading`/
`channel_exhausted` all exercised), plus a full open→voucher→close cycle on
a throwaway channel with both transaction hashes confirmed on Horizon. See
`docs/sdd/payments-mpp.md` §6, "Lote E" for the evidence, deviations, and
known limitations (no `settle` on the deployable wasm; one channel per
server process).
