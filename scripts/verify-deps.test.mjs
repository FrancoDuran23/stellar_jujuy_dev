import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PINNED_PACKAGES,
  collectResolvedVersions,
  evaluateDependencyTree,
  runNpmLs,
} from "./verify-deps.mjs";

function npmLsTree(dependencies) {
  return { name: "payments-mpp", dependencies };
}

test("collectResolvedVersions finds a single nested version", () => {
  const tree = npmLsTree({
    "@stellar/mpp": {
      version: "0.7.1",
      dependencies: {
        "@stellar/stellar-sdk": { version: "15.1.0" },
      },
    },
    "@stellar/stellar-sdk": { version: "15.1.0" },
  });
  const versions = collectResolvedVersions(tree, "@stellar/stellar-sdk");
  assert.deepEqual([...versions], ["15.1.0"]);
});

test("evaluateDependencyTree passes when every pin resolves to exactly one matching version", () => {
  const tree = npmLsTree({
    "@stellar/stellar-sdk": { version: "15.1.0" },
    mppx: { version: "0.6.29", dependencies: { "@stellar/stellar-sdk": { version: "15.1.0" } } },
  });
  const result = evaluateDependencyTree(tree, PINNED_PACKAGES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("evaluateDependencyTree fails on duplicated versions of a pinned package", () => {
  const tree = npmLsTree({
    "@stellar/stellar-sdk": { version: "15.1.0" },
    mppx: {
      version: "0.6.29",
      dependencies: {
        // simulates issue #70: a peer range resolves an older stellar-sdk copy
        "@stellar/stellar-sdk": { version: "14.0.0" },
      },
    },
  });
  const result = evaluateDependencyTree(tree, PINNED_PACKAGES);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /@stellar\/stellar-sdk: multiple versions resolved/);
  assert.match(result.problems[0], /14\.0\.0/);
  assert.match(result.problems[0], /15\.1\.0/);
});

test("evaluateDependencyTree fails when the single resolved version does not match the pin", () => {
  const tree = npmLsTree({ mppx: { version: "0.6.0" } });
  const result = evaluateDependencyTree(tree, { mppx: "0.6.29" });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /resolved 0\.6\.0, expected 0\.6\.29/);
});

test("evaluateDependencyTree fails when a pinned package is missing entirely", () => {
  const result = evaluateDependencyTree(npmLsTree({}), { mppx: "0.6.29" });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /not found in the dependency tree/);
});

test("runNpmLs parses stdout from an injected exec function (single version passes)", () => {
  const fakeExec = () =>
    JSON.stringify(
      npmLsTree({
        "@stellar/stellar-sdk": { version: "15.1.0" },
        mppx: { version: "0.6.29" },
      }),
    );
  const tree = runNpmLs(["@stellar/stellar-sdk", "mppx"], fakeExec);
  const result = evaluateDependencyTree(tree, PINNED_PACKAGES);
  assert.equal(result.ok, true);
});

test("runNpmLs parses stdout from an injected exec function (duplicate version fails)", () => {
  const fakeExec = () =>
    JSON.stringify(
      npmLsTree({
        "@stellar/stellar-sdk": { version: "15.1.0" },
        mppx: {
          version: "0.6.29",
          dependencies: { "@stellar/stellar-sdk": { version: "14.0.0" } },
        },
      }),
    );
  const tree = runNpmLs(["@stellar/stellar-sdk", "mppx"], fakeExec);
  const result = evaluateDependencyTree(tree, PINNED_PACKAGES);
  assert.equal(result.ok, false);
});

test("runNpmLs falls back to error.stdout when npm ls exits non-zero", () => {
  const fakeExec = () => {
    const error = new Error("npm ls exited with code 1");
    error.stdout = JSON.stringify(npmLsTree({ mppx: { version: "0.6.29" } }));
    throw error;
  };
  const tree = runNpmLs(["mppx"], fakeExec);
  assert.equal(tree.dependencies.mppx.version, "0.6.29");
});
