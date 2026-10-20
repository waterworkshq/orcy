/**
 * ARTIFACT MODULE — "a path to a complete, current, compiled api package".
 *
 * The artifact module owns everything about *producing* and *publishing* the
 * compiled api package; it knows nothing about how a consumer arranges that
 * package into a scenario (that is the layout module's job).
 *
 * Interface (in the full sense — everything a caller must know):
 *
 *  - Channel: the published path is handed to workers through the environment
 *    variable {@link COMPILED_API_ARTIFACT_ENV}. It is present only when a
 *    compiled consumer was selected for the run and the coordinator published
 *    the artifact successfully.
 *  - The published path is `<run root>/current` — a symlink to the current
 *    generation directory. It is swapped atomically, so the path itself never
 *    changes for the lifetime of a run.
 *  - "Current" means: the published generation was compiled from the run's
 *    production inputs (sources, effective tsconfig chain, compiler version)
 *    as recorded in the publish marker. The coordinator republishes only when
 *    those inputs change.
 *  - Failure mode: an absent channel, a missing marker, a corrupt marker or a
 *    missing dist directory fails with an explicit error. A consumer never
 *    reads partial output.
 *
 * Publication is atomic: the compiler writes into a private staging directory
 * that is a same-filesystem SIBLING of the destination, and the staged
 * generation is published with `rename(2)`. `rename(2)` is not atomic across
 * filesystems (EXDEV), so the staging directory never lives in `tmpdir()` and
 * there is no copy-based fallback.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Environment variable that carries the published artifact path to workers. */
export const COMPILED_API_ARTIFACT_ENV = "ORCY_COMPILED_API_ARTIFACT";

/** File name of the publish marker inside a published generation directory. */
export const COMPILED_API_MARKER_FILE = "artifact.json";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/**
 * Root that owns every run-scoped compiled artifact. It is a dedicated root of
 * its own — never `packages/api/dist`, which the live `dist/` importers read.
 * It sits inside the api package so that a published generation resolves its
 * runtime dependencies exactly like the per-file builds did: Node walks up from
 * the compiled module and finds `packages/api/node_modules`.
 */
const ARTIFACT_BASE = join(PACKAGE_ROOT, ".compiled-api");
const RUNS_DIR = join(ARTIFACT_BASE, "runs");
const PROOFS_DIR = join(ARTIFACT_BASE, "proofs");

/** The effective build configuration of the api package. */
const BUILD_CONFIG = join(PACKAGE_ROOT, "tsconfig.build.json");
const BUILD_SOURCES = ["src", "db"];

const BUILD_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
/** A heartbeat older than this means the owner stopped heart-beating. */
const HEARTBEAT_STALE_MS = 120_000;
/** Grace period between SIGTERM and SIGKILL for the owned compiler tree. */
const KILL_GRACE_MS = 5_000;
/** Grace period used when a cancellation signal has to end the run. */
const SIGNAL_TERM_GRACE_MS = 1_500;
const SIGNAL_KILL_GRACE_MS = 2_000;

/** Raised when the owner cancelled a build. */
export class CompiledApiCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompiledApiCancelledError";
  }
}

export interface CompiledApiArtifact {
  /** The published path carried by the environment channel. */
  publishedPath: string;
  /** The run root that owns the published generation. */
  runRoot: string;
  /** Compiled output reached through the published path (may be a symlink). */
  distDir: string;
  /** Compiled output with every symlink resolved — the copy source. */
  realDistDir: string;
  /** The compiled api entrypoint. */
  entrypoint: string;
  /** Hash of the production inputs this generation was compiled from. */
  inputHash: string;
  /** ISO timestamp of the publication. */
  publishedAt: string;
}

export interface CompiledApiRun {
  runId: string;
  runRoot: string;
  ownerPath: string;
  proofPath: string;
  publishes: number;
}

/** Marker written next to a published generation; its absence means "not consumable". */
export interface PublishMarker {
  schema: number;
  complete: boolean;
  inputHash: string;
  compilerVersion: string;
  publishedAt: string;
  distDirName: string;
}

// ---------------------------------------------------------------------------
// Production input hashing
// ---------------------------------------------------------------------------

function isExcludedSource(relativePath: string): boolean {
  if (relativePath.startsWith(`test${sep}`)) return true;
  if (relativePath.split(sep).includes("test")) return true;
  return relativePath.endsWith(".test.ts");
}

function collectProductionSources(): string[] {
  const files: string[] = [];
  for (const root of BUILD_SOURCES) {
    const absoluteRoot = join(PACKAGE_ROOT, root);
    if (!existsSync(absoluteRoot)) continue;
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = relative(absoluteRoot, full);
        if (isExcludedSource(relativePath)) continue;
        files.push(`${root}/${relativePath.split(sep).join("/")}`);
      }
    };
    walk(absoluteRoot);
  }
  return files.toSorted();
}

function tsconfigChain(start: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    let parsed: { extends?: string | string[] };
    try {
      parsed = JSON.parse(readFileSync(current, "utf8")) as { extends?: string | string[] };
    } catch {
      break;
    }
    const declared = Array.isArray(parsed.extends) ? parsed.extends[0] : parsed.extends;
    if (typeof declared !== "string") break;
    current = resolve(dirname(current), declared.endsWith(".json") ? declared : `${declared}.json`);
  }
  return chain;
}

function compilerVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "node_modules", "typescript", "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    return `${manifest.name ?? "typescript"}@${manifest.version ?? "unknown"}`;
  } catch {
    return "typescript@unknown";
  }
}

/**
 * Hash of every production input of the api build: the compiled sources, the
 * effective tsconfig chain and the compiler version. Test-only sources are
 * excluded, so editing a test never invalidates the published artifact.
 */
export function computeCompiledApiInputHash(): string {
  const hash = createHash("sha256");
  const sources = collectProductionSources();
  hash.update(`sources:${sources.length}\n`);
  for (const source of sources) {
    hash.update(source);
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(join(PACKAGE_ROOT, source), "utf8")).digest());
    hash.update("\n");
  }
  for (const config of tsconfigChain(BUILD_CONFIG)) {
    hash.update(relative(WORKSPACE_ROOT, config));
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(config, "utf8")).digest());
    hash.update("\n");
  }
  hash.update(`compiler:${compilerVersion()}\n`);
  return hash.digest("hex");
}

/** Escape a path for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pattern matching every production input of the api build: the compiled
 * sources and the effective tsconfig chain.
 *
 * It is a PREFIX pattern, not an enumeration, so a newly added source file
 * matches as well. Test-only sources (`src/test/**`) never match — a
 * test-only edit must not invalidate the published artifact.
 */
export function compiledApiProductionInputPattern(): RegExp {
  const packageRoot = escapeRegExp(PACKAGE_ROOT);
  const workspaceRoot = escapeRegExp(WORKSPACE_ROOT);
  return new RegExp(
    [
      // Compiled sources (everything under src/ except the test tree).
      `^${packageRoot}/src/(?!test/)(?!.*\\.test\\.ts$)`,
      // The effective tsconfig chain.
      `^${packageRoot}/tsconfig[^/]*\\.json$`,
      `^${workspaceRoot}/tsconfig[^/]*\\.json$`,
    ].join("|"),
  );
}

// ---------------------------------------------------------------------------
// Run roots, ownership and reclamation
// ---------------------------------------------------------------------------

function writeOwner(run: CompiledApiRun): void {
  const owner = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  writeFileSync(run.ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
}

/**
 * Create the run-scoped root that owns this run's compiled artifact. The root
 * records its owner (pid + hostname + heartbeat) so a later run can tell an
 * abandoned root from a live one.
 */
export function createCompiledApiRun(): CompiledApiRun {
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(PROOFS_DIR, { recursive: true });
  const runId = `run-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const runRoot = join(RUNS_DIR, runId);
  mkdirSync(join(runRoot, "layouts"), { recursive: true });
  mkdirSync(join(runRoot, "consumers"), { recursive: true });
  const run: CompiledApiRun = {
    runId,
    runRoot,
    ownerPath: join(runRoot, "owner.json"),
    proofPath: join(PROOFS_DIR, `${runId}.json`),
    publishes: 0,
  };
  writeOwner(run);
  return run;
}

/** Keep the run's owner record fresh; the timer never holds the process open. */
export function startCompiledApiHeartbeat(run: CompiledApiRun): () => void {
  const timer = setInterval(() => {
    try {
      const owner = JSON.parse(readFileSync(run.ownerPath, "utf8")) as Record<string, unknown>;
      owner.heartbeatAt = new Date().toISOString();
      writeFileSync(run.ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
    } catch {
      // A lost owner record is not fatal: the run keeps working, it simply
      // cannot be reclaimed by a later run.
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function isProvablyDeadOwner(owner: unknown): boolean {
  if (!owner || typeof owner !== "object") return false;
  const record = owner as { pid?: unknown; hostname?: unknown; heartbeatAt?: unknown };
  if (typeof record.pid !== "number" || typeof record.hostname !== "string") return false;
  // Another host's owner cannot be probed for liveness — never reclaim it.
  if (record.hostname !== hostname()) return false;
  if (record.pid === process.pid) return false;
  const heartbeatAt = Date.parse(typeof record.heartbeatAt === "string" ? record.heartbeatAt : "");
  if (!Number.isFinite(heartbeatAt)) return false;
  // A fresh heartbeat means the owner is alive even if its pid was recycled.
  if (Date.now() - heartbeatAt < HEARTBEAT_STALE_MS) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Reclaim run roots whose owner is provably dead. Never a global prefix
 * sweep: a root is removed only when its own owner record proves the owner
 * is gone, so two simultaneous runs never destroy each other's artifacts.
 */
export function reclaimAbandonedCompiledApiRuns(): string[] {
  const reclaimed: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(RUNS_DIR, { withFileTypes: true });
  } catch {
    return reclaimed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
    const runRoot = join(RUNS_DIR, entry.name);
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(join(runRoot, "owner.json"), "utf8"));
    } catch {
      continue; // No readable owner record — not provably abandoned.
    }
    if (!isProvablyDeadOwner(owner)) continue;
    rmSync(runRoot, { recursive: true, force: true });
    reclaimed.push(runRoot);
  }
  return reclaimed;
}

// ---------------------------------------------------------------------------
// Compilation and atomic publication
// ---------------------------------------------------------------------------

interface CompileOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The build was cancelled by the owner. */
  cancelled: boolean;
  /** The build exceeded its time budget and was terminated. */
  timedOut: boolean;
}

/** The compiler tree this process owns while a compile is in flight. */
interface OwnedCompiler {
  /** Process-group id of the compiler tree (the detached child's pid). */
  pgid: number;
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
  /** Grace period between SIGTERM and SIGKILL for this tree. */
  killGraceMs: number;
}

let activeCompiler: OwnedCompiler | undefined;

/**
 * A process group may only be signalled when this process actually owns it.
 * A group id that was never handed out by a successful spawn is refused —
 * `kill(-1, …)` would signal every process, `kill(1, …)` would signal init.
 */
function isOwnedGroup(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!isOwnedGroup(pgid)) return;
  try {
    // The compiler runs in its own process group, so the whole tree (pnpm →
    // tsc → tsgo) is signalled at once.
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

function isGroupAlive(pgid: number): boolean {
  if (!isOwnedGroup(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

/** Wait (without blocking the event loop) until the compiler group is empty. */
async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pgid)) return true;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  return !isGroupAlive(pgid);
}

/** Wait (blocking the event loop) until the compiler group is empty. */
function waitForGroupExitSync(pgid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pgid)) return true;
    sleepSync(25);
  }
  return !isGroupAlive(pgid);
}

/**
 * Terminate the compiler group and make sure nothing survives it.
 *
 * The group is signalled, then escalated to SIGKILL, and the group is only
 * released once it is empty — a descendant that ignores SIGTERM must not
 * outlive the build it belongs to.
 */
async function terminateGroup(pgid: number, graceMs: number): Promise<void> {
  if (!isGroupAlive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  if (await waitForGroupExit(pgid, graceMs)) return;
  signalGroup(pgid, "SIGKILL");
  await waitForGroupExit(pgid, graceMs);
}

/**
 * Ask the compiler tree this process owns to stop. Used by graceful
 * cancellation so an interrupted run leaves no compiler behind.
 */
export function cancelActiveApiCompiler(signal: NodeJS.Signals = "SIGTERM"): void {
  if (!activeCompiler) return;
  activeCompiler.cancelled = true;
  const pgid = activeCompiler.pgid;
  const grace = activeCompiler.killGraceMs;
  signalGroup(pgid, signal);
  // Escalate if the tree does not go away on its own.
  setTimeout(() => signalGroup(pgid, "SIGKILL"), grace).unref?.();
}

/**
 * Terminate the owned compiler tree and WAIT for it, without blocking the
 * event loop for longer than the escalation budget. This is the path a
 * cancellation signal takes: the process must not be able to exit while a
 * compiler descendant is still alive.
 */
export function terminateActiveApiCompilerTree(graceMs?: number): void {
  if (!activeCompiler) return;
  const pgid = activeCompiler.pgid;
  activeCompiler.cancelled = true;
  signalGroup(pgid, "SIGTERM");
  if (waitForGroupExitSync(pgid, graceMs ?? SIGNAL_TERM_GRACE_MS)) return;
  signalGroup(pgid, "SIGKILL");
  waitForGroupExitSync(pgid, SIGNAL_KILL_GRACE_MS);
}

/** A compiler invocation owned by this process. */
export interface CompilerInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Time budget for the whole compiler tree. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL for this tree. */
  killGraceMs?: number;
}

/**
 * Run an owned compiler tree and await its COMPLETE termination.
 *
 * The compiler is spawned detached, so it leads its own process group and the
 * group can be terminated as a unit. The tree is only released once the
 * group is empty: a descendant that survives the direct child's exit (for
 * example because it ignores SIGTERM) is escalated to SIGKILL and awaited
 * before this call settles.
 */
export async function runOwnedCompiler(invocation: CompilerInvocation): Promise<CompileOutcome> {
  const startedAt = Date.now();
  const timeoutMs = invocation.timeoutMs ?? BUILD_TIMEOUT_MS;
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? WORKSPACE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: invocation.env ?? process.env,
  });
  const spawnError = new Promise<Error>((accept) => child.once("error", accept));
  if (child.pid === undefined) {
    // The compiler could not be started: no process was created, so there is
    // NO process group to own and nothing may be signalled.
    const error = await spawnError;
    throw new Error(
      `compiled api build could not be started (${invocation.command}): ${error.message}`,
    );
  }
  const pgid = child.pid;
  const killGraceMs = invocation.killGraceMs ?? KILL_GRACE_MS;
  const owned: OwnedCompiler = { pgid, child, cancelled: false, timedOut: false, killGraceMs };
  activeCompiler = owned;

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-16_384);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384);
  });

  const timer = setTimeout(() => {
    owned.timedOut = true;
    signalGroup(pgid, "SIGTERM");
    setTimeout(() => signalGroup(pgid, "SIGKILL"), killGraceMs).unref?.();
  }, timeoutMs);
  timer.unref?.();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (accept) => {
      child.once("exit", (code, signal) => accept({ code, signal }));
      child.once("error", () => accept({ code: null, signal: null }));
    },
  );
  clearTimeout(timer);

  // The direct child is gone; the group may still hold descendants.
  await terminateGroup(pgid, killGraceMs);
  if (activeCompiler === owned) activeCompiler = undefined;

  const outcome: CompileOutcome = {
    code: exit.code,
    signal: exit.signal,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    cancelled: owned.cancelled,
    timedOut: owned.timedOut,
  };
  if (outcome.timedOut) {
    throw new Error(
      `compiled api build exceeded ${timeoutMs}ms and was terminated\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (outcome.cancelled) {
    throw new CompiledApiCancelledError(
      `compiled api build was cancelled and its compiler tree was terminated\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (exit.code !== 0) {
    throw new Error(
      `compiled api build failed (code=${exit.code} signal=${exit.signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return outcome;
}

/**
 * Compile the api package into `stagingDist` and await the compiler tree.
 * A build timeout or a graceful cancellation terminates AND awaits the owned
 * compiler processes instead of leaving them behind.
 */
export async function compileApiInto(stagingDist: string): Promise<CompileOutcome> {
  return runOwnedCompiler({
    command: "corepack",
    args: ["pnpm", "--filter", "@orcy/api", "build", "--outDir", stagingDist],
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=2048`.trim(),
    },
  });
}

/**
 * Publish a staged generation into the run root and swap the published path
 * onto it. Both steps are `rename(2)` calls inside the run root, so the
 * published path never exposes a partially written generation.
 */
export function publishStagedArtifact(
  run: CompiledApiRun,
  staging: string,
  generationName: string,
  marker: PublishMarker,
): string {
  const generation = join(run.runRoot, generationName);
  writeFileSync(join(staging, COMPILED_API_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
  // Atomic publication of the whole generation (same filesystem, same parent).
  renameSync(staging, generation);
  // Atomic swap of the published path onto the new generation.
  const pointer = join(run.runRoot, `.current-${process.pid}-${run.publishes}`);
  rmSync(pointer, { force: true });
  symlinkSync(generationName, pointer);
  renameSync(pointer, join(run.runRoot, "current"));
  return generation;
}

export interface PublishOptions {
  /** Compile into a staging generation and publish it. */
  inputHash?: string;
}

/**
 * Compile the api package once and publish it for every consumer of this run.
 * The compile count is recorded in the run's compile log — the proof that a
 * single compile served all consumers.
 */
export async function publishCompiledApiArtifact(
  run: CompiledApiRun,
  options: PublishOptions = {},
): Promise<CompiledApiArtifact> {
  const inputHash = options.inputHash ?? computeCompiledApiInputHash();
  const generationName = `gen-${String(run.publishes).padStart(3, "0")}-${inputHash.slice(0, 16)}`;
  // The staging directory is a same-filesystem SIBLING of the destination:
  // rename(2) cannot cross filesystems (EXDEV) and a copy-based fallback would
  // reopen the partial-visibility window this module exists to close.
  const staging = join(run.runRoot, `.staging-${process.pid}-${run.publishes}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(staging, "dist"), { recursive: true });

  const startedAt = new Date().toISOString();
  let outcome: CompileOutcome;
  try {
    outcome = await compileApiInto(join(staging, "dist"));
  } catch (error) {
    // A failed build never publishes reusable output.
    rmSync(staging, { recursive: true, force: true });
    appendFileSync(
      join(run.runRoot, "compiles.jsonl"),
      `${JSON.stringify({ seq: run.publishes + 1, startedAt, finishedAt: new Date().toISOString(), ok: false, inputHash, error: String(error) })}\n`,
    );
    throw error;
  }

  const publishedAt = new Date().toISOString();
  const marker: PublishMarker = {
    schema: 1,
    complete: true,
    inputHash,
    compilerVersion: compilerVersion(),
    publishedAt,
    distDirName: "dist",
  };
  publishStagedArtifact(run, staging, generationName, marker);
  run.publishes += 1;
  appendFileSync(
    join(run.runRoot, "compiles.jsonl"),
    `${JSON.stringify({ seq: run.publishes, startedAt, finishedAt: publishedAt, ok: true, inputHash, generation: generationName, durationMs: outcome.durationMs })}\n`,
  );

  return readPublishedArtifact(join(run.runRoot, "current"), run.runRoot);
}

/** Read and validate the publish marker of a published path. */
function readPublishedArtifact(publishedPath: string, runRoot: string): CompiledApiArtifact {
  const markerPath = join(publishedPath, COMPILED_API_MARKER_FILE);
  if (!existsSync(markerPath)) {
    throw new Error(
      `compiled api artifact is not published: marker ${markerPath} is missing — the directory was never published (staging is not consumable)`,
    );
  }
  let marker: PublishMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8")) as PublishMarker;
  } catch (error) {
    throw new Error(
      `compiled api artifact marker ${markerPath} is corrupt — refusing to read partial output`,
      { cause: error },
    );
  }
  if (!marker || marker.complete !== true || typeof marker.inputHash !== "string" || !marker.inputHash) {
    throw new Error(
      `compiled api artifact marker ${markerPath} is incomplete — refusing to read partial output`,
    );
  }
  const distDir = join(publishedPath, marker.distDirName ?? "dist");
  const entrypoint = join(distDir, "index.js");
  if (!existsSync(entrypoint)) {
    throw new Error(
      `compiled api artifact at ${publishedPath} is incomplete: ${entrypoint} is missing`,
    );
  }
  return {
    publishedPath,
    runRoot,
    distDir,
    realDistDir: realpathSync(distDir),
    entrypoint,
    inputHash: marker.inputHash,
    publishedAt: marker.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Consumer side
// ---------------------------------------------------------------------------

/**
 * Resolve the published artifact from the environment channel. Fails with an
 * explicit error when the channel is absent or the published artifact is not
 * complete — a consumer never reads partial output.
 */
export function resolveCompiledApiArtifact(): CompiledApiArtifact {
  const publishedPath = process.env[COMPILED_API_ARTIFACT_ENV];
  if (!publishedPath) {
    throw new Error(
      `compiled api artifact was not published for this run: ${COMPILED_API_ARTIFACT_ENV} is unset — no compiled consumer was selected, or the coordinator failed before publishing`,
    );
  }
  const runRoot = dirname(publishedPath);
  return readPublishedArtifact(publishedPath, runRoot);
}

let consumptionSequence = 0;

/**
 * Record that a consumer used the published artifact. The record is the
 * per-consumer half of the compile-count proof.
 */
export function recordCompiledApiConsumption(
  artifact: CompiledApiArtifact,
  consumer: { name: string; layout: string },
): void {
  const directory = join(artifact.runRoot, "consumers");
  try {
    mkdirSync(directory, { recursive: true });
    const name = `${String(process.pid).padStart(6, "0")}-${String(++consumptionSequence).padStart(3, "0")}.json`;
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(
        {
          pid: process.pid,
          consumer: consumer.name,
          layout: consumer.layout,
          inputHash: artifact.inputHash,
          publishedAt: artifact.publishedAt,
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // The proof is best-effort telemetry; it never fails a consumer.
  }
}

// ---------------------------------------------------------------------------
// Run finalisation
// ---------------------------------------------------------------------------

export interface CompiledApiProof {
  runId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  finishedAt: string;
  selectedConsumers: string[];
  /** Compile attempts recorded by the coordinator. */
  compiles: number;
  /** Compiles that produced a published generation. */
  successfulCompiles: number;
  compileLog: unknown[];
  consumers: unknown[];
  consumerCount: number;
  distinctConsumerInputHashes: number;
}

/**
 * Write the run's proof file (compile count + per-consumer usage) and drop the
 * run root. The proof survives the run; the compiled output does not.
 */
export function finalizeCompiledApiRun(
  run: CompiledApiRun,
  selectedConsumers: string[],
  startedAt: string,
): CompiledApiProof {
  const compileLog: unknown[] = [];
  try {
    const raw = readFileSync(join(run.runRoot, "compiles.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        compileLog.push(JSON.parse(line));
      } catch {
        // A truncated log line is skipped, not fatal.
      }
    }
  } catch {
    // No compiles were recorded.
  }

  const consumers: unknown[] = [];
  try {
    for (const entry of readdirSync(join(run.runRoot, "consumers"))) {
      try {
        consumers.push(JSON.parse(readFileSync(join(run.runRoot, "consumers", entry), "utf8")));
      } catch {
        // Skip an unreadable record.
      }
    }
  } catch {
    // No consumer recorded a usage.
  }

  const hashes = new Set(
    consumers.map((consumer) => (consumer as { inputHash?: string }).inputHash).filter(Boolean) as string[],
  );
  const proof: CompiledApiProof = {
    runId: run.runId,
    pid: process.pid,
    hostname: hostname(),
    startedAt,
    finishedAt: new Date().toISOString(),
    selectedConsumers,
    compiles: compileLog.length,
    successfulCompiles: compileLog.filter(
      (entry) => (entry as { ok?: boolean }).ok === true,
    ).length,
    compileLog,
    consumers,
    consumerCount: consumers.length,
    distinctConsumerInputHashes: hashes.size,
  };
  try {
    mkdirSync(PROOFS_DIR, { recursive: true });
    writeFileSync(run.proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  } catch {
    // A missing proof file never fails the run.
  }
  rmSync(run.runRoot, { recursive: true, force: true });
  return proof;
}
