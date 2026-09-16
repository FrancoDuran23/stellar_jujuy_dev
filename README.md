# payments-mpp

Micropayment component for the connectivity product: a `server` (recipient)
and an `agent` (funder) that meter and settle Stellar/Soroban payments so the
gateway/meter can bill by bytes consumed. Full requirements and design live in
`docs/sdd/payments-mpp.md`.

## Status

Stage 1 (sponsored charge server + headless agent client) and stage 1.5
(`POST /vouchers` against simulated consumption, with a `serve` mode for the
agent) are implemented — `npm run server`, `npm run agent`, and
`npm run agent:serve` all work. The channel CLIs (`channel:*`, escalón 2,
`WU6` onward) are not built yet and remain behind the **T8.2** human gate
(see `docs/sdd/payments-mpp.md` §5/§6). What already works: dependency
install, type checking, the full unit test suite, `verify:deps`, and both
processes end-to-end against a real testnet `.env`.

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
| Module boundaries | One npm package, folder-enforced boundaries: `shared/` has zero knowledge of `agent/`, `server/`, `cli/`, or `persistence/`. See `docs/sdd/payments-mpp.md` §4.1. |
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
`docs/sdd/payments-mpp.md` §6, "T8.2 — evidencia testnet". Escalón 2
(`WU6`/`WU7`) work can now start.
