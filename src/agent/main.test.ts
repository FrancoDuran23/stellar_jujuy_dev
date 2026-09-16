// Mode dispatch for `agent/main.ts` (review finding, Lote D, MINOR: the
// `serve` mode added alongside the existing one-shot CLI). `resolveMode` is
// the only thing imported here on purpose — importing the rest of the module
// would also run its top-level side effects were it not guarded behind an
// "am I the entrypoint" check, which this test also implicitly exercises by
// importing the module without triggering `app.listen()` or a real purchase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, resolveCumulativeBytes } from "./main.ts";

test("resolveMode defaults to one-shot with no argv[2]", () => {
  assert.equal(resolveMode(["node", "src/agent/main.ts"]), "one-shot");
});

test("resolveMode returns serve only for the literal 'serve' argument", () => {
  assert.equal(resolveMode(["node", "src/agent/main.ts", "serve"]), "serve");
  assert.equal(resolveMode(["node", "src/agent/main.ts", "Serve"]), "one-shot");
  assert.equal(resolveMode(["node", "src/agent/main.ts", "--serve"]), "one-shot");
});

// T8.2 open finding #2: `npm run agent` had no way to pass `?cumulativeBytes=`
// at all. Precedence: `--bytes` flag, then `CUMULATIVE_BYTES` env, then the
// 1 MiB default (matching `server/routes/charge.ts`'s own default).

test("resolveCumulativeBytes defaults to 1 MiB with no flag and no env var", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts"], {});
  assert.deepEqual(result, { ok: true, value: 1_048_576n });
});

test("resolveCumulativeBytes reads --bytes <n>", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts", "--bytes", "2097152"], {});
  assert.deepEqual(result, { ok: true, value: 2_097_152n });
});

test("resolveCumulativeBytes falls back to CUMULATIVE_BYTES when --bytes is absent", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts"], { CUMULATIVE_BYTES: "3145728" });
  assert.deepEqual(result, { ok: true, value: 3_145_728n });
});

test("resolveCumulativeBytes prefers --bytes over CUMULATIVE_BYTES when both are given", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts", "--bytes", "10"], {
    CUMULATIVE_BYTES: "99999",
  });
  assert.deepEqual(result, { ok: true, value: 10n });
});

test("resolveCumulativeBytes treats an empty CUMULATIVE_BYTES (dotenv's bare `KEY=`) as unset", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts"], { CUMULATIVE_BYTES: "" });
  assert.deepEqual(result, { ok: true, value: 1_048_576n });
});

test("resolveCumulativeBytes accepts zero (a legitimate non-negative integer)", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts", "--bytes", "0"], {});
  assert.deepEqual(result, { ok: true, value: 0n });
});

test("resolveCumulativeBytes rejects a --bytes value with no argument following it", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts", "--bytes"], {});
  assert.equal(result.ok, false);
});

test("resolveCumulativeBytes rejects a malformed --bytes value (decimal, negative, non-numeric)", () => {
  for (const raw of ["-1", "1.5", "abc", "007"]) {
    const result = resolveCumulativeBytes(["node", "src/agent/main.ts", "--bytes", raw], {});
    assert.equal(result.ok, false, `expected "${raw}" to be rejected`);
  }
});

test("resolveCumulativeBytes rejects a malformed CUMULATIVE_BYTES env value", () => {
  const result = resolveCumulativeBytes(["node", "src/agent/main.ts"], { CUMULATIVE_BYTES: "not-a-number" });
  assert.equal(result.ok, false);
});
