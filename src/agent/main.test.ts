// Mode dispatch for `agent/main.ts` (review finding, Lote D, MINOR: the
// `serve` mode added alongside the existing one-shot CLI). `resolveMode` is
// the only thing imported here on purpose — importing the rest of the module
// would also run its top-level side effects were it not guarded behind an
// "am I the entrypoint" check, which this test also implicitly exercises by
// importing the module without triggering `app.listen()` or a real purchase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode } from "./main.ts";

test("resolveMode defaults to one-shot with no argv[2]", () => {
  assert.equal(resolveMode(["node", "src/agent/main.ts"]), "one-shot");
});

test("resolveMode returns serve only for the literal 'serve' argument", () => {
  assert.equal(resolveMode(["node", "src/agent/main.ts", "serve"]), "serve");
  assert.equal(resolveMode(["node", "src/agent/main.ts", "Serve"]), "one-shot");
  assert.equal(resolveMode(["node", "src/agent/main.ts", "--serve"]), "one-shot");
});
