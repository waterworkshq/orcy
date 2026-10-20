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
      // Wait for the build to be under way: the compiler's command line
      // carries the staging directory of the run that owns it.
      const compilerStarted = await waitFor(
        () => compilerProcesses().length > 0,
        60_000,
      );
      expect(compilerStarted, `no compiler process was observed\n${output}`).toBe(true);

      // Signal the run the way an operator (or CI) would.
      child.kill("SIGTERM");
      const exit = await exited;

      // The owned compiler tree must be gone WHEN the run ends, not merely
      // moments later.
      expect(compilerProcesses()).toEqual([]);
      expect(await waitFor(() => compilerProcesses().length === 0, 5_000)).toBe(true);
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
  }, 120_000);
});

/** Compiler processes of this repository's shared-build staging directories. */
function compilerProcesses(): number[] {
  const found: number[] = [];
  const mine = ancestorPids();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    // This process and its ancestors are never the compiler tree.
    if (mine.has(pid)) continue;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes(".compiled-api")) continue;
    found.push(pid);
  }
  return found;
}

function ancestorPids(): Set<number> {
  const ancestors = new Set<number>();
  let pid = process.pid;
  while (pid > 1) {
    ancestors.add(pid);
    pid = parentPid(pid);
  }
  return ancestors;
}

function parentPid(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.split(") ")[1]?.split(" ")[1] ?? 0);
  } catch {
    return 0;
  }
}
