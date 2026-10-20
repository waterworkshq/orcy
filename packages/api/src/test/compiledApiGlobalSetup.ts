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
 *  4. it registers the production-input watch trigger for the selected
 *     consumers, so a watch cycle republishes only when a production input
 *     changed — a test-only edit never rebuilds;
 *  5. it installs the cancellation handlers BEFORE any compile starts, so a
 *     signal during the initial build terminates and awaits the owned
 *     compiler tree instead of leaking it.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseCLI, type TestProject } from "vitest/node";
import {
  COMPILED_API_ARTIFACT_ENV,
  CompiledApiCancelledError,
  computeCompiledApiInputHash,
  createCompiledApiRun,
  finalizeCompiledApiRun,
  publishCompiledApiArtifact,
  reclaimAbandonedCompiledApiRuns,
  startCompiledApiHeartbeat,
  terminateActiveApiCompilerTree,
  compiledApiProductionInputPattern,
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

  // Cancellation handlers are installed BEFORE the first compile: a signal
  // during the initial build must terminate and await the owned compiler
  // tree. `prependListener` puts them ahead of Vitest's own handler, which
  // exits the process a millisecond after the signal.
  const onSigint = (): void => {
    process.exitCode = 130;
    terminateActiveApiCompilerTree();
  };
  const onSigterm = (): void => {
    process.exitCode = 143;
    terminateActiveApiCompilerTree();
  };
  process.prependListener("SIGINT", onSigint);
  process.prependListener("SIGTERM", onSigterm);

  const { testFiles } = await project.globTestFiles(cliFilters());
  const consumers = testFiles
    .filter(isCompiledConsumer)
    .map((file) => relative(project.config.root, file))
    .toSorted();
  const consumerFiles = testFiles.filter(isCompiledConsumer);

  let artifact: CompiledApiArtifact | undefined;
  if (consumers.length > 0) {
    try {
      artifact = await publishCompiledApiArtifact(run);
    } catch (error) {
      // A failed build never publishes reusable output: drop the run root and
      // surface the failure before any test executes.
      stopHeartbeat();
      finalizeCompiledApiRun(run, consumers, startedAt);
      if (error instanceof CompiledApiCancelledError) {
        // The run was cancelled by a signal: end it the way the signal means
        // instead of reporting a failed build.
        console.error(`[compiled-api] ${error.message}`);
        process.exit(process.exitCode ?? 143);
      }
      throw error;
    }
    process.env[COMPILED_API_ARTIFACT_ENV] = artifact.publishedPath;
    console.log(
      `[compiled-api] published ${artifact.publishedPath} (input ${artifact.inputHash.slice(0, 12)}) for ${consumers.length} compiled consumer(s)`,
    );
  } else {
    console.log("[compiled-api] no compiled consumer selected — nothing was compiled");
  }

  // Watch contract — two halves:
  //
  //  a) Vitest's own source-import graph does not know that a compiled
  //     consumer depends on the COMPILED output, so a change to a
  //     compiled-only production file schedules no rerun at all. The trigger
  //     below connects the production inputs to the selected consumers.
  //  b) The rebuild happens in `onTestsRerun`, which Vitest awaits before it
  //     dispatches the rerun — so a consumer never executes against a stale
  //     artifact.
  const productionInputPattern = compiledApiProductionInputPattern();
  project.vitest.config.watchTriggerPatterns = [
    ...(project.vitest.config.watchTriggerPatterns ?? []),
    {
      pattern: productionInputPattern,
      testsToRun: () => consumerFiles,
    },
  ];

  // A DELETED input is not routed through Vitest's trigger machinery, so it
  // is routed explicitly to schedule the consumer rerun.
  const onProductionInputRemoved = (file: string): void => {
    if (!productionInputPattern.test(file)) return;
    project.vitest.watcher.onFileChange(file);
  };
  project.vite.watcher.on("unlink", onProductionInputRemoved);

  project.onTestsRerun(async () => {
    if (!artifact) return;
    const inputHash = computeCompiledApiInputHash();
    if (inputHash === artifact.inputHash) return;
    artifact = await publishCompiledApiArtifact(run, { inputHash });
    process.env[COMPILED_API_ARTIFACT_ENV] = artifact.publishedPath;
    console.log(`[compiled-api] republished for changed production inputs (${inputHash.slice(0, 12)})`);
  });

  return () => {
    project.vite.watcher.off("unlink", onProductionInputRemoved);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    // Nothing this process owns may outlive the run.
    terminateActiveApiCompilerTree();
    stopHeartbeat();
    const proof = finalizeCompiledApiRun(run, consumers, startedAt);
    console.log(
      `[compiled-api] run ${proof.runId}: ${proof.compiles} compile(s), ${proof.consumerCount} consumer(s), proof ${run.proofPath}`,
    );
  };
}
