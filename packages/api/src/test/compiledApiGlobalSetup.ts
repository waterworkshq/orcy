/**
 * RUN-SCOPED COORDINATOR — the vitest `globalSetup` that owns the shared
 * compiled artifact for one test run.
 *
 * The coordinator runs once per vitest process, before any worker is spawned:
 *
 *  1. it reclaims run roots whose owner is provably dead (never a prefix
 *     sweep — two simultaneous runs keep each other's artifacts);
 *  2. it decides whether this run selects a compiled consumer at all — a
 *     focused unit-test command that selects none must not build;
 *  3. when a consumer is selected it compiles ONCE into a private staging
 *     directory and publishes it atomically, then hands the published path to
 *     the workers through the environment channel;
 *  4. on a watch rerun it republishes only when the production inputs
 *     changed — a test-only edit never rebuilds.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseCLI, type TestProject } from "vitest/node";
import {
  COMPILED_API_ARTIFACT_ENV,
  computeCompiledApiInputHash,
  createCompiledApiRun,
  finalizeCompiledApiRun,
  killActiveApiCompiler,
  publishCompiledApiArtifact,
  reclaimAbandonedCompiledApiRuns,
  startCompiledApiHeartbeat,
  type CompiledApiArtifact,
} from "./compiledApiArtifact.js";

/**
 * A test file is a compiled consumer when it imports the layout seam (or the
 * fixture façade that sits on top of it). The check is a static import scan of
 * the selected files — no consumer reaches around the artifact module.
 */
const CONSUMER_MODULES = ["compiledApiLayout", "compiledApiFixture"];

function isCompiledConsumer(file: string): boolean {
  try {
    const source = readFileSync(file, "utf8");
    return CONSUMER_MODULES.some((module) => source.includes(module));
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
  const startedAt = new Date().toISOString();
  reclaimAbandonedCompiledApiRuns();

  const run = createCompiledApiRun();
  const stopHeartbeat = startCompiledApiHeartbeat(run);

  const { testFiles } = await project.globTestFiles(cliFilters());
  const consumers = testFiles
    .filter(isCompiledConsumer)
    .map((file) => relative(project.config.root, file))
    .toSorted();

  let artifact: CompiledApiArtifact | undefined;
  if (consumers.length > 0) {
    try {
      artifact = await publishCompiledApiArtifact(run);
    } catch (error) {
      // A failed build never publishes reusable output: drop the run root and
      // surface the failure before any test executes.
      stopHeartbeat();
      finalizeCompiledApiRun(run, consumers, startedAt);
      throw error;
    }
    process.env[COMPILED_API_ARTIFACT_ENV] = artifact.publishedPath;
    console.log(
      `[compiled-api] published ${artifact.publishedPath} (input ${artifact.inputHash.slice(0, 12)}) for ${consumers.length} compiled consumer(s)`,
    );
  } else {
    console.log("[compiled-api] no compiled consumer selected — nothing was compiled");
  }

  // Watch contract: a rerun republishes only when a production input changed.
  project.onTestsRerun(async () => {
    if (!artifact) return;
    const inputHash = computeCompiledApiInputHash();
    if (inputHash === artifact.inputHash) return;
    artifact = await publishCompiledApiArtifact(run, { inputHash });
    process.env[COMPILED_API_ARTIFACT_ENV] = artifact.publishedPath;
    console.log(`[compiled-api] republished for changed production inputs (${inputHash.slice(0, 12)})`);
  });

  // Graceful cancellation terminates the owned compiler tree.
  const onSignal = (): void => {
    killActiveApiCompiler("SIGTERM");
    setTimeout(() => killActiveApiCompiler("SIGKILL"), 5_000).unref?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stopHeartbeat();
    const proof = finalizeCompiledApiRun(run, consumers, startedAt);
    console.log(
      `[compiled-api] run ${proof.runId}: ${proof.compiles} compile(s), ${proof.consumerCount} consumer(s), proof ${run.proofPath}`,
    );
  };
}
