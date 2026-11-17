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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseCLI, type TestProject } from "vitest/node";
import { buildWireTargets, WIRE_BUILD_DONE_ENV } from "./wireBuild.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Watcher event paths carry platform separators; the patterns below are slash-anchored. */
function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Content fingerprint of one walked input. Set membership alone cannot see
 * an input EDITED IN PLACE inside the build window — the path sits in both
 * snapshots and no watcher event predates the watch — so the baseline vs
 * post-build comparison is content-sensitive (same shape as the compiled-api
 * artifact's input hash). An unreadable file reads as "" ("changed"), never
 * as a crash: a file can vanish between the directory read and this read.
 */
function inputFingerprint(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

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
    return parseCLI(["vitest", ...process.argv.slice(2)]).filter.map((filter) =>
      // A line filter ("file.test.ts:42", "file.test.ts:10-20") narrows within
      // a file — globbing must see the bare file path or the match returns
      // nothing and a selected wire consumer would look unselected.
      filter.replace(/:\d+(-\d+)?$/, ""),
    );
  } catch {
    return [];
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const { testFiles } = await project.globTestFiles(cliFilters());
  const consumerFiles = testFiles.filter(isWireConsumer);
  const consumers = consumerFiles.map((file) => relative(project.config.root, file)).toSorted();

  if (consumers.length === 0) {
    console.log("[mcp-wire] no wire consumer selected — nothing was compiled");
    return () => {};
  }

  // Vitest's source-import graph does not know the wire consumers depend on
  // the COMPILED output, so a production-input edit schedules no rerun at all.
  // Route the four built packages' inputs to the selected consumers (mirrors
  // the api coordinator's watch trigger). Vitest ids use forward slashes —
  // normalize the workspace root so the anchored pattern matches on Windows.
  const workspaceRoot = resolve(project.config.root, "..", "..").replace(/\\/g, "/");
  const snapshotInputsPrecedingRun = (): Map<string, string> => {
    const known = new Map<string, string>();
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        known.set(slash(full), inputFingerprint(full));
      }
    };
    for (const pkg of ["api", "mcp", "daemon", "shared"]) {
      const pkgDir = resolve(workspaceRoot, "packages", pkg);
      const srcDir = join(pkgDir, "src");
      if (existsSync(srcDir)) walk(srcDir);
      for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")) {
          known.set(slash(join(pkgDir, entry.name)), inputFingerprint(join(pkgDir, entry.name)));
        }
      }
    }
    return known;
  };
  // Baseline BEFORE the build: the initial build runs for a while, and a
  // production input that appears (or vanishes) inside that window is absent
  // from dist yet predates the watch — no watcher event will ever surface
  // it. Only the pre-build baseline makes such inputs distinguishable.
  const baselineInputs = snapshotInputsPrecedingRun();
  buildWireTargets(project.config.root);
  console.log(`[mcp-wire] compiled wire targets once for ${consumers.length} consumer(s): ${consumers.join(", ")}`);

  const productionInputs = new RegExp(
    `^${escapeRegExp(workspaceRoot)}/packages/(?:api|mcp|daemon|shared)/(?:src/(?!test/)(?!.*\\.test\\.ts$)|tsconfig[^/]*\\.json$)`,
  );
  project.vitest.config.watchTriggerPatterns = [
    ...(project.vitest.config.watchTriggerPatterns ?? []),
    { pattern: productionInputs, testsToRun: () => consumerFiles },
  ];
  // The project watcher only covers this package by default; the wire targets
  // compile three sibling packages too, so put those package ROOTS under
  // watch — the productionInputs pattern above also counts their root-level
  // tsconfig*.json, and an unwatched match means the edit silently schedules
  // nothing. (Vite's watcher ignores node_modules; dist/ writes match neither
  // the trigger nor the change flag, so they stay inert.)
  project.vite.watcher.add([
    resolve(project.config.root, "..", "api"),
    resolve(project.config.root, "..", "daemon"),
    resolve(project.config.root, "..", "shared"),
  ]);
  // A production-input edit must rebuild before the rerun dispatches, but a
  // test-file-only save must not pay the four-package build. The change flag
  // is set by the watcher events themselves (change, add, and unlink) and
  // consumed by the rerun hook below. Event paths are slash-normalized — the
  // anchored pattern must also match the backslash-separated paths chokidar
  // delivers on Windows.
  //
  // Every production input on disk once the watch is up. watcher.add() of
  // the sibling roots rescans them; chokidar v5 silences that scan through
  // ignoreInitial, but add() returns the watcher (no settle promise) and
  // "ready" never re-fires — so instead of racing the scan, an "add" for a
  // path the snapshot already knows is treated as scan noise and must not
  // arm the rebuild. "unlink" below keeps the snapshot current, so a
  // delete-and-recreate still arms.
  const knownInputs = snapshotInputsPrecedingRun();
  // Inputs that changed while the initial build ran are real changes the
  // watcher will never report (they predate the watch and the silent rescan)
  // — arm now so the FIRST rerun rebuilds instead of executing against a
  // dist that lacks them. Membership deltas cover inputs that appeared or
  // vanished; the fingerprint comparison also catches an input EDITED IN
  // PLACE (present in both snapshots, different content).
  const inputChangedDuringBuild =
    [...knownInputs].some(
      ([input, fingerprint]) => productionInputs.test(input) && baselineInputs.get(input) !== fingerprint,
    ) ||
    [...baselineInputs].some(([input]) => productionInputs.test(input) && !knownInputs.has(input));
  let productionInputChanged = inputChangedDuringBuild;
  const markProductionInputChange = (file: string): void => {
    if (productionInputs.test(slash(file))) productionInputChanged = true;
  };
  project.vite.watcher.on("change", markProductionInputChange);
  // A NEWLY CREATED input emits chokidar "add", not "change" — the trigger
  // machinery routes adds to a rerun, so without arming here that rerun would
  // execute against the stale dist.
  const markNewProductionInput = (file: string): void => {
    const normalized = slash(file);
    if (!productionInputs.test(normalized) || knownInputs.has(normalized)) return;
    knownInputs.set(normalized, inputFingerprint(normalized));
    productionInputChanged = true;
  };
  project.vite.watcher.on("add", markNewProductionInput);
  // A DELETED input is not routed through the trigger machinery, so route it
  // explicitly to schedule the consumer rerun (and still count as a change).
  const onProductionInputRemoved = (file: string): void => {
    const normalized = slash(file);
    if (!productionInputs.test(normalized)) return;
    knownInputs.delete(normalized);
    productionInputChanged = true;
    project.vitest.watcher.onFileChange(file);
  };
  project.vite.watcher.on("unlink", onProductionInputRemoved);

  // Watch contract — vitest never re-runs global setup on reruns, and the
  // workers' env handshake would keep serving the initial build. Rebuild
  // before the rerun dispatches (vitest awaits this hook), but only when a
  // production input actually changed. buildWireTargets passes
  // --noEmitOnError, so a failed rebuild leaves the previous dist in place
  // and the rerun below runs against the last good output.
  project.onTestsRerun(() => {
    if (!productionInputChanged) return;
    productionInputChanged = false;
    delete process.env[WIRE_BUILD_DONE_ENV];
    try {
      buildWireTargets(project.config.root);
      console.log("[mcp-wire] rebuilt wire targets for watch rerun");
    } catch (error) {
      // A failed rebuild (e.g. a compile error mid-watch) must not abort the
      // rerun. execSync's message is a bare "Command failed" — the compiler
      // diagnostics live in stderr, so surface those. The flag is restored so
      // consumers keep the last good dist (noEmitOnError left it untouched):
      // worker fallback rebuilds would only race and re-fail.
      const detail = ((error as { stderr?: Buffer }).stderr?.toString() ?? String(error)).trim();
      process.env[WIRE_BUILD_DONE_ENV] = "1";
      console.error(`[mcp-wire] wire target rebuild failed — keeping the previous dist:\n${detail}`);
    }
  });

  return () => {
    project.vite.watcher.off("change", markProductionInputChange);
    project.vite.watcher.off("add", markNewProductionInput);
    project.vite.watcher.off("unlink", onProductionInputRemoved);
  };
}
