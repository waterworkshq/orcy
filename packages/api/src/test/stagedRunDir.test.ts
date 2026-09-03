/**
 * Unit discriminators for the per-invocation staged-suite run-dir owner
 * mechanism (`helpers/stagedRunDir.ts`).
 *
 * Hermetic by construction: every test allocates its own throwaway parent
 * under os.tmpdir() — NEVER the real `packages/api/.test-staged-enforcement`
 * parent — so these tests cannot disturb concurrent real staged runs, and
 * real runs cannot disturb them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  allocateStagedRunDir,
  recoverStaleRuns,
} from "./helpers/stagedRunDir.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("stagedRunDir owner mechanism", () => {
  let parent: string;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "staged-run-dir-test-"));
  });
  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("allocates distinct run directories, each carrying an owner marker", () => {
    const a = allocateStagedRunDir(parent);
    const b = allocateStagedRunDir(parent);
    expect(a).not.toBe(b);

    const markerA = JSON.parse(readFileSync(join(a, "owner.json"), "utf-8"));
    const markerB = JSON.parse(readFileSync(join(b, "owner.json"), "utf-8"));
    expect(markerA.pid).toBe(process.pid);
    expect(markerB.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(markerA.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(markerB.startedAt))).toBe(true);
  });

  it("recovers a sibling whose recorded pid is dead", () => {
    // Spawn a real child, let it exit, then reuse its (now dead) pid. Linux
    // allocates pids sequentially, so a just-reaped pid cannot be recycled
    // before the recovery scan runs.
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(child.status).toBe(0);
    expect(child.pid).toBeGreaterThan(0);

    const own = allocateStagedRunDir(parent);
    const dead = join(parent, "run-dead");
    mkdirSync(dead);
    // Fresh marker: liveness — not age — must be the discriminator here.
    writeFileSync(
      join(dead, "owner.json"),
      JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
      "utf-8",
    );

    recoverStaleRuns(parent);

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(own)).toBe(true);
  });

  it("preserves a sibling whose recorded pid is live (current process)", () => {
    const own = allocateStagedRunDir(parent);
    const live = join(parent, "run-live");
    mkdirSync(live);
    writeFileSync(
      join(live, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf-8",
    );

    recoverStaleRuns(parent);

    expect(existsSync(live)).toBe(true);
    expect(existsSync(own)).toBe(true);
  });

  it("preserves a malformed-marker sibling with a fresh mtime, removes one older than 24h", () => {
    const own = allocateStagedRunDir(parent);
    const freshMalformed = join(parent, "run-malformed-fresh");
    const staleMalformed = join(parent, "run-malformed-stale");
    mkdirSync(freshMalformed);
    mkdirSync(staleMalformed);
    writeFileSync(join(freshMalformed, "owner.json"), "{not json", "utf-8");
    writeFileSync(join(staleMalformed, "owner.json"), "{not json", "utf-8");
    const old = new Date(Date.now() - DAY_MS - 60_000);
    utimesSync(staleMalformed, old, old);

    recoverStaleRuns(parent);

    expect(existsSync(freshMalformed)).toBe(true);
    expect(existsSync(staleMalformed)).toBe(false);
    expect(existsSync(own)).toBe(true);
  });
});
