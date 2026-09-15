#!/usr/bin/env node
// Fails the build if @stellar/stellar-sdk or mppx resolve to more than one
// version in the dependency tree, or if the resolved version does not match
// the pin in package.json. Plain Node (no shell one-liners): the team
// develops on Windows, where `npm ls ... > /dev/null` does not behave the
// same way it does in bash (R14, design 4.9).
//
// Not wired to `postinstall` on purpose: running `npm ls` from inside an npm
// lifecycle script is fragile (design 4.4). Run it manually after install and
// again before the demo.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import process from "node:process";

export const PINNED_PACKAGES = {
  "@stellar/stellar-sdk": "15.1.0",
  mppx: "0.6.29",
};

/**
 * Walks an `npm ls --json` dependency node and collects every resolved
 * version of `packageName` found anywhere in the (sub)tree.
 */
export function collectResolvedVersions(node, packageName, seen = new Set()) {
  const versions = new Set();
  if (!node || typeof node !== "object") {
    return versions;
  }
  const dependencies = node.dependencies ?? {};
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency || typeof dependency !== "object") {
      continue;
    }
    const identity = `${name}@${dependency.version ?? "?"}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    if (name === packageName && typeof dependency.version === "string") {
      versions.add(dependency.version);
    }
    for (const nested of collectResolvedVersions(dependency, packageName, seen)) {
      versions.add(nested);
    }
  }
  return versions;
}

/**
 * Pure decision function: given a parsed `npm ls --json` tree, decides
 * whether every pinned package resolves to exactly one version that matches
 * its pin.
 */
export function evaluateDependencyTree(npmLsOutput, pins = PINNED_PACKAGES) {
  const problems = [];
  for (const [packageName, pin] of Object.entries(pins)) {
    const versions = collectResolvedVersions(npmLsOutput, packageName);
    if (versions.size === 0) {
      problems.push(`${packageName}: not found in the dependency tree`);
      continue;
    }
    if (versions.size > 1) {
      problems.push(
        `${packageName}: multiple versions resolved (${[...versions].sort().join(", ")})`,
      );
      continue;
    }
    const [resolved] = versions;
    if (resolved !== pin) {
      problems.push(`${packageName}: resolved ${resolved}, expected ${pin}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Runs `npm ls <packages> --all --json`. `execFn` is injectable so tests can
 * fake the npm CLI output without spawning a real process.
 */
export function runNpmLs(packageNames, execFn = execFileSync) {
  let stdout;
  try {
    stdout = execFn("npm", ["ls", ...packageNames, "--all", "--json"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  } catch (error) {
    // `npm ls` exits non-zero on unrelated tree issues (e.g. extraneous
    // packages) even when the JSON payload we need is valid on stdout.
    if (error && typeof error.stdout === "string" && error.stdout.length > 0) {
      stdout = error.stdout;
    } else {
      throw error;
    }
  }
  return JSON.parse(stdout);
}

export function main(execFn = execFileSync) {
  const packageNames = Object.keys(PINNED_PACKAGES);
  const npmLsOutput = runNpmLs(packageNames, execFn);
  const result = evaluateDependencyTree(npmLsOutput);
  if (!result.ok) {
    console.error("verify:deps found dependency problems:");
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
    return result;
  }
  console.log("verify:deps: single resolved version for every pinned package.");
  return result;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error("verify:deps failed to run npm ls:", error?.message ?? error);
    process.exitCode = 1;
  }
}
