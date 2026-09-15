import { test } from "node:test";
import assert from "node:assert/strict";

// First test in the suite: proves the pipeline works end to end before any
// production code exists — Node's native TypeScript type stripping, the
// erasableSyntaxOnly tsconfig, and `node --test` all agree on this file.
test("node:test runs .ts sources directly, no build step", () => {
  assert.equal(1 + 1, 2);
});
