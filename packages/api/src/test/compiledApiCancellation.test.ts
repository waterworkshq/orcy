/**
 * Cancellation regression tests for the compiled-artifact machinery.
 *
 * Two properties are proved here:
 *
 *  1. The owned compiler TREE is terminated, not just the direct child: a
 *     descendant that ignores SIGTERM must not outlive the build it belongs
 *     to — neither after a build timeout nor after a graceful cancellation.
 *  2. A cancellation SIGNAL that arrives while the initial build is running
 *     ends the run with no owned compiler descendant surviving.
 *
 * The tests drive the machinery through its public interface; the fake
 * compiler is a real parent/grandchild process tree.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cancelActiveApiCompiler,
  runOwnedCompiler,
} from "./compiledApiArtifact.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orcy-compiler-cancel-"));
  roots.push(root);
  return root;
}

/**
 * A fake compiler: it spawns a grandchild that ignores SIGTERM and records
 * its pid. The direct child dies on the default SIGTERM disposition (like
 * `corepack`/`pnpm` do), so the grandchild is exactly the shape that used to
 * outlive the build: the tree's leader is gone while a descendant that only
 * SIGKILL can stop is still running.
 */
function writeResistantCompiler(root: string): { script: string; pidFile: string } {
  const script = join(root, "resistant-compiler.mjs");
  const pidFile = join(root, "grandchild.pid");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [pidFile] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
writeFileSync(pidFile, String(grandchild.pid));
setInterval(() => {}, 1000);
`,
  );
  return { script, pidFile };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  return predicate();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owned compiler tree termination", () => {
  it("kills a SIGTERM-resistant descendant when the build times out", async () => {
    const root = makeRoot();
    const { script, pidFile } = writeResistantCompiler(root);

    await expect(
      runOwnedCompiler({
        command: process.execPath,
        args: [script, pidFile],
        timeoutMs: 400,
        killGraceMs: 250,
      }),
    ).rejects.toThrow(/exceeded/);

    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(grandchild)).toBe(false);
  });

  it("kills a SIGTERM-resistant descendant when the build is cancelled", async () => {
    const root = makeRoot();
    const { script, pidFile } = writeResistantCompiler(root);

    const running = runOwnedCompiler({
      command: process.execPath,
      args: [script, pidFile],
      timeoutMs: 60_000,
      killGraceMs: 250,
    });
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(grandchild)).toBe(true);

    cancelActiveApiCompiler("SIGTERM");
    await expect(running).rejects.toThrow(/cancelled/);
    expect(isAlive(grandchild)).toBe(false);
  });
});

describe("cancellation signal during the initial build", () => {
  it("leaves no owned compiler descendant behind", async () => {
    await expectCancelledRunToLeaveNoCompiler();
  });

  it("ignores a concurrent foreign process that only looks like a compiler", async () => {
    // A foreign process that merely carries a staging-shaped path must never
    // be mistaken for this run's compiler.
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "/tmp/.compiled-api/.staging-foreign/run-foreign/dist"],
      { stdio: "ignore" },
    );
    try {
      await expectCancelledRunToLeaveNoCompiler(foreign.pid);
    } finally {
      foreign.kill("SIGKILL");
    }
  }, 180_000);
});

/**
 * Run a nested Vitest run, cancel it while its build is under way, and
 * assert that the compiler tree OWNED by that run does not survive it.
 *
 * Ownership is established by the nested run's own run root (its name carries
 * the nested run's pid) and by the process ancestry: a foreign process that
 * looks like a compiler is never part of the ownership set.
 */
async function expectCancelledRunToLeaveNoCompiler(foreignPid?: number): Promise<void> {
  const vitestBin = join(PACKAGE_ROOT, "node_modules", "vitest", "vitest.mjs");
  const child = spawn(
    process.execPath,
    [
      vitestBin,
      "run",
      "src/test/webhookRetryBootSmoke.test.ts",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ],
    { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => {
    child.once("exit", (code, signal) => accept({ code, signal }));
  });

  try {
    const nestedPid = child.pid ?? 0;
    // The nested run's OWN run root — its name carries the nested run's pid.
    const runRoot = await waitForRunRoot(nestedPid, 30_000);
    expect(runRoot, `the nested run created no run root\n${output}`).not.toBe("");

    // Wait for the build to be under way: the compiler is a descendant of the
    // nested run and writes into the nested run's own staging directory.
    const owned = await waitForOwnedCompiler(nestedPid, runRoot, 60_000);
    expect(owned.length, `no owned compiler process was observed\n${output}`).toBeGreaterThan(0);
    if (foreignPid !== undefined) {
      expect(owned).not.toContain(foreignPid);
    }

    // Signal the run the way an operator (or CI) would.
    child.kill("SIGTERM");
    const exit = await exited;

    // The owned compiler tree must be gone WHEN the run ends, not merely
    // moments later. The identity captured above is preserved even though the
    // nested run's death reparents its descendants.
    const survivors = [...new Set([...owned, ...processesInRunRoot(runRoot)])].filter(isSurviving);
    expect(survivors, `compiler tree survived the cancelled run:\n${describeProcesses(survivors)}`).toEqual([]);
    expect(await waitFor(() => survivorsOf(owned, runRoot).length === 0, 5_000)).toBe(true);
    expect(exit.code ?? exit.signal).toBeTruthy();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-(child.pid ?? -1), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}

/** The run root of the run owned by `pid` (its name carries the owner's pid). */
function ownedRunRoot(pid: number): string {
  const runsDir = join(PACKAGE_ROOT, ".compiled-api", "runs");
  let entries: string[] = [];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return "";
  }
  const entry = entries.find((name) => name.startsWith(`run-${pid}-`));
  return entry ? join(runsDir, entry) : "";
}

async function waitForRunRoot(pid: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runRoot = ownedRunRoot(pid);
    if (runRoot) return runRoot;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  return "";
}

/**
 * The compiler processes OWNED by the nested run: descendants of the nested
 * run that write into the nested run's own run root.
 */
function ownedCompilerProcesses(rootPid: number, runRoot: string): number[] {
  const descendants = descendantsOf(rootPid);
  return processesInRunRoot(runRoot).filter((pid) => descendants.has(pid));
}

async function waitForOwnedCompiler(
  rootPid: number,
  runRoot: string,
  timeoutMs: number,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let owned: number[] = [];
  while (Date.now() < deadline) {
    owned = ownedCompilerProcesses(rootPid, runRoot);
    if (owned.length > 0) return owned;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  return owned;
}

/** Every process that writes into the given run root. */
function processesInRunRoot(runRoot: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const cmdline = readCmdline(pid);
    if (!cmdline) continue;
    if (!cmdline.includes(runRoot)) continue;
    found.push(pid);
  }
  return found;
}

function survivorsOf(owned: number[], runRoot: string): number[] {
  return [...new Set([...owned, ...processesInRunRoot(runRoot)])].filter(isSurviving);
}

/** A process that is still running (a reaped-but-unwaited zombie is not). */
function isSurviving(pid: number): boolean {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[0];
    return state !== undefined && state !== "Z";
  } catch {
    return false;
  }
}

/** The descendants of a process, by the parent chain. */
function descendantsOf(rootPid: number): Set<number> {
  const parents = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    parents.set(pid, parentPid(pid));
  }
  const descendants = new Set<number>();
  for (const pid of parents.keys()) {
    let current = pid;
    const seen = new Set<number>();
    while (current > 1 && !seen.has(current)) {
      seen.add(current);
      if (current === rootPid) {
        descendants.add(pid);
        break;
      }
      current = parents.get(current) ?? 0;
    }
  }
  return descendants;
}

/** Human-readable description of the given processes, for failure output. */
function describeProcesses(pids: number[]): string {
  return pids
    .map((pid) => {
      let cmdline = "";
      let state = "?";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
        state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[0] ?? "?";
      } catch {
        // The process is gone.
      }
      return `  ${pid} [${state}] ${cmdline}`;
    })
    .join("\n");
}

function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "";
  }
}

function parentPid(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.split(") ")[1]?.split(" ")[1] ?? 0);
  } catch {
    return 0;
  }
}
