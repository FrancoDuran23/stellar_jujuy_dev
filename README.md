# payments-mpp

Micropayment component for the connectivity product: a `server` (recipient)
and an `agent` (funder) that meter and settle Stellar/Soroban payments so the
gateway/meter can bill by bytes consumed. Full requirements and design live in
`docs/sdd/payments-mpp.md`.

## Status

Work units WU0 (scaffolding), WU1 (shared) and WU2 (persistence) are
implemented. `server/`, `agent/`, and the channel CLIs (`WU3` onward) are not
built yet — `npm run server`, `npm run agent`, and the `channel:*` scripts
will fail until those work units land. What already works: dependency
install, type checking, the full unit test suite, and `verify:deps`.

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

Continue with WU3 (stage 1 charge server + headless agent client) once a
human has completed the day-1 spikes in `docs/sdd/payments-mpp.md` §4.8.
