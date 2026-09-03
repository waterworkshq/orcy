/**
 * Per-invocation ownership for the staged-enforcement suite's temp directory.
 *
 * The staged suite's databases live under one checkout-constant parent
 * (`.test-staged-enforcement`). Every invocation of the suite allocates a
 * UNIQUE `run-*` directory inside that parent, so two Vitest processes
 * running the suite in the same checkout never unlink each other's live
 * database files. Crash residue is recovered liveness-aware: only run
 * directories whose recorded owner pid is dead (or whose marker/contents are
 * older than 24h, the PID-reuse guard) are removed — a live sibling is never
 * touched, and nothing that may be live is ever removed.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Marker written inside every allocated run directory. */
export interface StagedRunOwner {
  pid: number;
  startedAt: string;
}

const MARKER_NAME = "owner.json";
const RUN_PREFIX = "run-";
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Allocate a unique run directory inside `parent` and record this process as
 * its owner. The directory name is unique by construction (mkdtemp).
 */
export function allocateStagedRunDir(parent: string): string {
  // mkdtemp does not create intermediate directories — the checkout-constant
  // parent may not exist yet on a fresh clone.
  mkdirSync(parent, { recursive: true });
  const runDir = mkdtempSync(join(parent, RUN_PREFIX));
  const owner: StagedRunOwner = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(join(runDir, MARKER_NAME), JSON.stringify(owner), "utf-8");
  return runDir;
}

function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // ESRCH: no such process. Anything else (e.g. EPERM — the process exists
    // but belongs to another user) counts as alive: fail safe, never remove
    // what may be live.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

interface OwnerMarker {
  pid?: number;
  startedAtMs?: number;
}

function readOwnerMarker(runDir: string): OwnerMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(runDir, MARKER_NAME), "utf-8"));
  } catch {
    return null; // missing or malformed
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : undefined;
  const startedAt =
    typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt))
      ? Date.parse(record.startedAt)
      : undefined;
  if (pid === undefined || startedAt === undefined) return null;
  return { pid, startedAtMs: startedAt };
}

/**
 * Remove stale sibling `run-*` directories from `parent`, preserving the
 * crash-recovery property without the shared-directory blast radius:
 *
 * - a well-formed marker: remove only if the recorded pid is dead (ESRCH), or
 *   the marker is older than 24h (the pid may have been recycled);
 * - a malformed/missing marker: remove only if the directory's mtime is
 *   older than 24h — otherwise skip (it may belong to a live run).
 *
 * Never follows symlinks out of the parent: recovery only ever considers
 * real directories directly inside `parent` (lstat, not stat).
 */
export function recoverStaleRuns(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return; // parent does not exist (or is unreadable) — nothing to recover
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(RUN_PREFIX)) continue;
    const dir = join(parent, entry);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue; // never follow symlinks; ignore files

    const marker = readOwnerMarker(dir);
    if (marker) {
      const stale = now - marker.startedAtMs! > STALE_MS;
      if (!stale && !isPidDead(marker.pid!)) continue; // live run — preserved
    } else {
      // Malformed/missing marker: fall back to directory age only.
      if (now - st.mtimeMs <= STALE_MS) continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
