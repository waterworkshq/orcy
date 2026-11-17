/**
 * RUN-SCOPED WIRE COORDINATOR — the vitest `globalSetup` that owns the
 * workspace build for one test run.
 *
 * It runs once per vitest process, before any worker is spawned:
 *
 *  1. it decides whether this run selects a wire consumer at all — a
 *     focused unit-test command that selects none must not build;
 *  2. when a consumer is selected it builds shared/daemon/api/mcp ONCE, so
 *     parallel wire files never rebuild the same dist/ trees concurrently
 *     (a spawned API child linking a dist/ that another worker's `tsc` is
 *     still rewriting boots into "does not provide an export named ...").
 *
 * Completion is handed to the workers through the environment channel
 * (workers inherit the main process env after global setup); the wire files'
 * `buildWireTargets` call becomes a no-op.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseCLI, type TestProject } from "vitest/node";
import { buildWireTargets } from "./wireBuild.js";

/**
 * A test file is a wire consumer when it imports the shared build seam. The
 * check is anchored to actual import statements — a file that merely
 * MENTIONS the module name in a comment or string is not a consumer.
 */
const WIRE_CONSUMER_IMPORT = /from\s*["'][^"']*wireBuild\.js["']/;

function isWireConsumer(file: string): boolean {
  try {
    return WIRE_CONSUMER_IMPORT.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** The file filters this run was started with, exactly as vitest parsed them. */
function cliFilters(): string[] {
  try {
    return parseCLI(["vitest", ...process.argv.slice(2)]).filter;
  } catch {
    return [];
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const { testFiles } = await project.globTestFiles(cliFilters());
  const consumers = testFiles
    .filter(isWireConsumer)
    .map((file) => relative(project.config.root, file))
    .toSorted();

  if (consumers.length === 0) {
    console.log("[mcp-wire] no wire consumer selected — nothing was compiled");
    return () => {};
  }

  buildWireTargets(project.config.root);
  console.log(`[mcp-wire] compiled wire targets once for ${consumers.length} consumer(s): ${consumers.join(", ")}`);
  return () => {};
}
