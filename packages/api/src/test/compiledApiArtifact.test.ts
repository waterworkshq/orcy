/**
 * Discriminating self-test of the compiled-artifact machinery.
 *
 * The safety property under test: a consumer can only ever read a COMPLETE,
 * PUBLISHED generation.
 *
 *  - an unpublished (staging) directory is not consumable;
 *  - a missing or corrupt publish marker makes the consumer fail cleanly
 *    instead of reading partial output;
 *  - publication MOVES the staged generation (rename(2)) instead of copying
 *    it — the inode assertions below fail if the atomic-rename step is
 *    replaced by a copy-based fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import {
  COMPILED_API_ARTIFACT_ENV,
  COMPILED_API_MARKER_FILE,
  createCompiledApiRun,
  publishStagedArtifact,
  reclaimAbandonedCompiledApiRuns,
  resolveCompiledApiArtifact,
  runOwnedCompiler,
  type CompiledApiRun,
} from "./compiledApiArtifact.js";

let run: CompiledApiRun;
let previousChannel: string | undefined;

function stageGeneration(): { staging: string; inode: number } {
  const staging = join(run.runRoot, `.staging-self-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(staging, "dist"), { recursive: true });
  writeFileSync(join(staging, "dist", "index.js"), "// compiled api self-test\n");
  return { staging, inode: statSync(join(staging, "dist")).ino };
}

function publish(staging: string): string {
  const generation = `gen-self-test-${Date.now()}`;
  publishStagedArtifact(run, staging, generation, {
    schema: 1,
    complete: true,
    inputHash: "self-test-input-hash",
    compilerVersion: "typescript@self-test",
    publishedAt: new Date().toISOString(),
    distDirName: "dist",
  });
  return join(run.runRoot, "current");
}

beforeEach(() => {
  run = createCompiledApiRun();
  previousChannel = process.env[COMPILED_API_ARTIFACT_ENV];
});

afterEach(() => {
  if (previousChannel === undefined) delete process.env[COMPILED_API_ARTIFACT_ENV];
  else process.env[COMPILED_API_ARTIFACT_ENV] = previousChannel;
  rmSync(run.runRoot, { recursive: true, force: true });
});

describe("compiled artifact publication", () => {
  it("publishes by moving the staged generation, not by copying it", () => {
    const { staging, inode } = stageGeneration();
    const publishedPath = publish(staging);

    // rename(2) preserves the inode; a copy-based fallback would not.
    expect(statSync(join(publishedPath, "dist")).ino).toBe(inode);
    // The staged directory was moved away — nothing partial is left behind.
    expect(existsSync(staging)).toBe(false);
  });

  it("makes a published generation consumable through the environment channel", () => {
    const { staging } = stageGeneration();
    const publishedPath = publish(staging);
    process.env[COMPILED_API_ARTIFACT_ENV] = publishedPath;

    const artifact = resolveCompiledApiArtifact();
    expect(artifact.inputHash).toBe("self-test-input-hash");
    expect(artifact.entrypoint).toBe(join(publishedPath, "dist", "index.js"));
  });

  it("refuses to consume an unpublished staging directory", () => {
    const { staging } = stageGeneration();
    process.env[COMPILED_API_ARTIFACT_ENV] = staging;

    expect(() => resolveCompiledApiArtifact()).toThrow(/not published/);
  });

  it("fails cleanly when the publish marker is missing", () => {
    const { staging } = stageGeneration();
    const publishedPath = publish(staging);
    rmSync(join(publishedPath, COMPILED_API_MARKER_FILE));
    process.env[COMPILED_API_ARTIFACT_ENV] = publishedPath;

    expect(() => resolveCompiledApiArtifact()).toThrow(/not published/);
  });

  it("fails cleanly when the publish marker is corrupt", () => {
    const { staging } = stageGeneration();
    const publishedPath = publish(staging);
    writeFileSync(join(publishedPath, COMPILED_API_MARKER_FILE), "{ this is not json");
    process.env[COMPILED_API_ARTIFACT_ENV] = publishedPath;

    expect(() => resolveCompiledApiArtifact()).toThrow(/corrupt/);
  });

  it("fails cleanly when the publish marker does not claim completeness", () => {
    const { staging } = stageGeneration();
    const publishedPath = publish(staging);
    writeFileSync(
      join(publishedPath, COMPILED_API_MARKER_FILE),
      JSON.stringify({ schema: 1, complete: false, inputHash: "x", publishedAt: "now" }),
    );
    process.env[COMPILED_API_ARTIFACT_ENV] = publishedPath;

    expect(() => resolveCompiledApiArtifact()).toThrow(/incomplete/);
  });

  it("fails cleanly when the published output is missing", () => {
    const { staging } = stageGeneration();
    const publishedPath = publish(staging);
    rmSync(join(publishedPath, "dist"), { recursive: true, force: true });
    process.env[COMPILED_API_ARTIFACT_ENV] = publishedPath;

    expect(() => resolveCompiledApiArtifact()).toThrow(/incomplete/);
  });

  it("refuses to resolve without the environment channel", () => {
    delete process.env[COMPILED_API_ARTIFACT_ENV];
    expect(() => resolveCompiledApiArtifact()).toThrow(/was not published/);
  });
});

describe("compiler process-group ownership", () => {
  it("never signals a process group when the compiler cannot be started", async () => {
    const signals: { pid: number; signal: unknown }[] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      signals.push({ pid, signal });
      return true;
    }) as typeof process.kill;
    let failure: unknown;
    try {
      await runOwnedCompiler({
        command: "/nonexistent-orcy-review-compiler",
        args: [],
        timeoutMs: 5_000,
        killGraceMs: 1,
      });
    } catch (error) {
      failure = error;
    } finally {
      process.kill = originalKill;
    }

    // A failed spawn registers no process group: PID 1 (init) and PID 0
    // ("every process this user may signal") must never be signalled.
    expect(signals.filter((entry) => entry.pid <= 1)).toEqual([]);
    expect(signals).toEqual([]);
    expect(String((failure as Error)?.message ?? failure)).toMatch(/could not be started/);
  });
});

describe("ownership-based reclamation", () => {
  it("reclaims a run root whose owner is provably dead", () => {
    const abandoned = createCompiledApiRun();
    try {
      // An owner that cannot be alive: a pid above the kernel's pid maximum and
      // a heartbeat far in the past.
      writeFileSync(
        abandoned.ownerPath,
        JSON.stringify({
          pid: 4_194_303,
          hostname: hostname(),
          startedAt: new Date(0).toISOString(),
          heartbeatAt: new Date(0).toISOString(),
        }),
      );

      const reclaimed = reclaimAbandonedCompiledApiRuns();
      expect(reclaimed).toContain(abandoned.runRoot);
      expect(existsSync(abandoned.runRoot)).toBe(false);
    } finally {
      // A failed assertion must not leak the abandoned root.
      rmSync(abandoned.runRoot, { recursive: true, force: true });
    }
  });

  it("never sweeps a run root whose owner is a live foreign process with a stale heartbeat", () => {
    // Discriminates the liveness probe: the owner pid is foreign (not this
    // process, so the same-pid early return does not apply) and its heartbeat
    // is stale — only `process.kill(pid, 0)` keeps the root alive. Removing
    // the probe (treating any stale heartbeat as dead) fails this test.
    const live = createCompiledApiRun();
    let foreign: ReturnType<typeof spawn> | undefined;
    try {
      // Spawned inside the try so the child is only started once its cleanup
      // is guaranteed to run.
      foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(
        live.ownerPath,
        JSON.stringify({
          pid: foreign.pid,
          hostname: hostname(),
          startedAt: new Date(0).toISOString(),
          heartbeatAt: new Date(0).toISOString(),
        }),
      );

      expect(reclaimAbandonedCompiledApiRuns()).not.toContain(live.runRoot);
      expect(existsSync(live.runRoot)).toBe(true);
    } finally {
      rmSync(live.runRoot, { recursive: true, force: true });
      foreign?.kill("SIGKILL");
    }
  });

  it("never sweeps a run root whose owner is alive", () => {
    // This run's own root is owned by the current process.
    expect(reclaimAbandonedCompiledApiRuns()).not.toContain(run.runRoot);
    expect(existsSync(run.runRoot)).toBe(true);
  });
});
