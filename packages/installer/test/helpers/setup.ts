/**
 * Characterization-test harness for @orcy/installer.
 *
 * Strategy (determined upstream — see plan): mock `@orcy/shared`'s `ORCY_PATHS`/
 * `ORCY_HOME` to a per-file temp dir, redirect the real `os.homedir()` by setting
 * `process.env.HOME`, let the real `node:fs` operate on the temp dir, and stub the
 * external process invocations (`node:child_process.execSync`) and network (`fetch`).
 *
 * IMPORTANT: `ORCY_PATHS` is `as const` computed at module-load time, and several
 * installer modules capture derived paths at their own load time (manifest.ts:
 * `MANIFEST_PATH`, credentials.ts: `CREDENTIALS_PATH`, service-installer.ts:
 * `PID_FILE`/`WRAPPER_SCRIPT`). This file MUST therefore be imported before any
 * installer source module so the `@orcy/shared` mock (and `process.env.HOME`) is in
 * place when those `const`s evaluate. Each test file imports this module FIRST.
 *
 * Per-file isolation: vitest isolates each test file in its own module registry, so
 * the top-level temp-home creation below runs once per file with a fresh dir.
 */
import { vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mutable bag accessible inside hoisted vi.mock factories (the only outer bindings
// vitest permits inside a mock factory).
const M = vi.hoisted(() => {
  const join = (...p: string[]) => p.join("/").replace(/\/{2,}/g, "/");
  return {
    join,
    home: "" as string, // temp HOME (sibling layout: ~/.orcy lives inside this)
    orcyHome: "" as string, // = home + "/.orcy"
    savedHome: undefined as string | undefined,
    savedFetch: null as typeof globalThis.fetch | null,
    // Per-command exec override hook: a test may return a value to short-circuit,
    // or throw to simulate a failure at a specific command. For execSync the cmd
    // is the literal command string; for execFileSync it is `file args.join(" ")`.
    execHook: null as null | ((cmd: string, opts?: unknown) => unknown),
    // Every intercepted child-process invocation (both execSync and execFileSync),
    // cleared in beforeEach, so tests can assert on exact file/args/cwd triples.
    execLog: [] as Array<{
      kind: "execSync" | "execFileSync";
      cmd: string;
      file?: string;
      args?: string[];
      opts?: unknown;
    }>,
    // The repo root's packageManager pin, mirrored into fake sources so a
    // deliberate pin bump needs no fixture edit (assigned at module top level
    // below — the vi.mock factories execute lazily, after it is set). Empty
    // placeholder: if the assignment ever fails, seeding an empty pin makes
    // every pin-aware suite fail loudly instead of silently reverting.
    repoPin: "" as string,
  };
});

// --- Mock @orcy/shared: ORCY_PATHS / ORCY_HOME / getOrcyConfig → temp home -------
vi.mock("@orcy/shared", () => {
  const h = M.orcyHome;
  const j = M.join;
  return {
    ORCY_HOME: h,
    ORCY_PATHS: {
      home: h,
      bin: j(h, "bin"),
      ui: j(h, "ui"),
      envFile: j(h, ".env"),
      credentialsFile: j(h, "credentials.json"),
      databaseFile: j(h, "orcy.db"),
      run: j(h, "run"),
      logs: j(h, "logs"),
    },
    getOrcyConfig: () => ({
      apiUrl: "http://127.0.0.1:4000",
      agentId: "",
      apiKey: "",
      orcyHome: h,
    }),
    resetConfig: () => {},
    getRemoteConfig: () => ({
      apiUrl: "http://127.0.0.1:4000",
      remoteKey: "",
      orcyHome: h,
    }),
    getAuthMode: () => "local_agent" as const,
  };
});

// --- Mock node:child_process: fake curl/tar/pnpm/systemctl; real node:fs --------
// Async factory so we can dynamically import fs/path (factory closures may not
// reference top-level bindings other than vi.hoisted ones).
vi.mock("node:child_process", async () => {
  const nfs = await import("node:fs");
  const npath = await import("node:path");

  function seedFakeSource(srcDir: string): void {
    // Root package.json carries the packageManager pin the pin-aware pnpm
    // runner derives its version from (mirrors the real repo root — derived,
    // so a deliberate pin bump needs no fixture edit).
    nfs.writeFileSync(
      npath.join(srcDir, "package.json"),
      JSON.stringify({
        name: "orcy",
        private: true,
        packageManager: M.repoPin,
      }),
    );
    for (const c of ["cli", "api", "mcp"]) {
      const dist = npath.join(srcDir, "packages", c, "dist");
      nfs.mkdirSync(dist, { recursive: true });
      nfs.writeFileSync(
        npath.join(dist, "index.js"),
        `#!/usr/bin/env node\nconsole.log("fake @orcy/${c}");\n`,
      );
      nfs.writeFileSync(
        npath.join(srcDir, "packages", c, "package.json"),
        JSON.stringify({ name: `@orcy/${c}`, version: "1.0.0", type: "module", dependencies: {} }),
      );
    }
    // UI dist is bundled by the api component.
    const uiDist = npath.join(srcDir, "packages", "ui", "dist");
    nfs.mkdirSync(uiDist, { recursive: true });
    nfs.writeFileSync(npath.join(uiDist, "index.html"), "<html>fake ui</html>");
    // drizzle migrations are bundled by the api component.
    const drizzle = npath.join(srcDir, "packages", "api", "drizzle");
    nfs.mkdirSync(drizzle, { recursive: true });
    nfs.writeFileSync(npath.join(drizzle, "0000_schema.sql"), "-- fake schema\n");
  }

  return {
    execSync: (cmd: string, opts?: unknown): string => {
      M.execLog.push({ kind: "execSync", cmd, opts });
      if (M.execHook) {
        const r = M.execHook(cmd, opts);
        if (r !== undefined) return r as string;
      }
      // curl ... -o "<archive>.tmp"  → materialize the download target
      const curl = cmd.match(/curl\s+.*-o\s+"([^"]+\.tmp)"/);
      if (curl) {
        nfs.mkdirSync(npath.dirname(curl[1]), { recursive: true });
        nfs.writeFileSync(curl[1], "fake-archive");
        return "";
      }
      // tar -xzf "<archive>" -C "<srcDir>" --strip-components=1  → seed fake source tree
      const tar = cmd.match(/tar\s+-xzf\s+"[^"]+"\s+-C\s+"([^"]+)"\s+--strip-components=1/);
      if (tar) {
        seedFakeSource(tar[1]);
        return "";
      }
      // pnpm / npm invocations (version check, install, -r build) → no-op success
      if (/^(pnpm|npm)\b/.test(cmd)) return "";
      // systemd / launchd invocations → no-op
      if (/systemctl|launchctl/.test(cmd)) return "";
      // id -u (used by launchd paths)
      if (cmd === "id -u") return "1000";
      throw new Error(`test execSync: unhandled command: ${cmd}`);
    },
    // Argument-array form used by the pin-aware pnpm runner: handle by file so
    // quoting-sensitive string matching is never relied on for these calls.
    execFileSync: (file: string, args: string[], opts?: unknown): string => {
      const argv = Array.isArray(args) ? args : [];
      const joined = [file, ...argv].join(" ");
      M.execLog.push({ kind: "execFileSync", cmd: joined, file, args: argv, opts });
      if (M.execHook) {
        const r = M.execHook(joined, opts);
        if (r !== undefined) return r as string;
      }
      if (file === "curl") {
        const out = argv[argv.indexOf("-o") + 1];
        if (out && out.endsWith(".tmp")) {
          nfs.mkdirSync(npath.dirname(out), { recursive: true });
          nfs.writeFileSync(out, "fake-archive");
          return "";
        }
        throw new Error(`test execFileSync: unhandled curl args: ${joined}`);
      }
      if (file === "tar") {
        const dir = argv[argv.indexOf("-C") + 1];
        if (dir) {
          seedFakeSource(dir);
          return "";
        }
        throw new Error(`test execFileSync: unhandled tar args: ${joined}`);
      }
      // corepack / npx (pin-aware pnpm runner: probes, installs, builds) → no-op
      if (file === "corepack" || file === "npx") return "";
      if (file === "systemctl" || file === "launchctl") return "";
      if (file === "id") return "1000";
      throw new Error(`test execFileSync: unhandled command: ${joined}`);
    },
  };
});

// --- Mock @clack/prompts (safety net; the non-interactive path never calls it) --
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(async () => true),
  multiselect: vi.fn(async () => []),
  select: vi.fn(
    async (opts: { options: Array<{ value: string }> }) => opts.options[0]?.value ?? "",
  ),
  text: vi.fn(async () => ""),
}));

// --- Create temp HOME + redirect os.homedir() (Linux reads process.env.HOME) ----
M.home = fs.mkdtempSync(path.join(os.tmpdir(), "orcy-install-test-"));
M.orcyHome = path.join(M.home, ".orcy");
fs.mkdirSync(M.orcyHome, { recursive: true });
M.savedHome = process.env.HOME;
process.env.HOME = M.home;
// The repo root's pin, read once (top-level runs before any lazily-executed
// vi.mock factory, so seedFakeSource sees the derived value).
M.repoPin = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "..", "..", "package.json"),
      "utf-8",
    ),
  ) as { packageManager?: string }
).packageManager!;

// --- Mock global fetch (agent registration POST; doctor health check) -----------
M.savedFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async (input: unknown, _init?: unknown) => {
  const url = typeof input === "string" ? input : ((input as { url?: string })?.url ?? "");
  if (url.includes("/api/agents")) {
    return new Response(
      JSON.stringify({ agent: { id: "agent-test-001" }, apiKey: "orcy-key-test" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.includes("/health")) {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof globalThis.fetch;

// Reset install/agent side-effects between tests within a file.
beforeEach(() => {
  M.execLog.length = 0;
  fs.rmSync(M.orcyHome, { recursive: true, force: true });
  fs.mkdirSync(M.orcyHome, { recursive: true });
  for (const sub of [
    ".claude",
    ".bashrc",
    ".zshrc",
    ".config",
    ".kilo",
    ".codex",
    ".gemini",
    ".cursor",
    ".kilocode",
    ".local",
  ]) {
    fs.rmSync(path.join(M.home, sub), { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(M.home, { recursive: true, force: true });
  if (M.savedHome !== undefined) process.env.HOME = M.savedHome;
  if (M.savedFetch) globalThis.fetch = M.savedFetch;
});

// --- Helpers exported to tests --------------------------------------------------
export function tempHome(): string {
  return M.home;
}

export function orcyHome(): string {
  return M.orcyHome;
}

export function manifestPath(): string {
  return path.join(M.orcyHome, "install-manifest.json");
}

export function readManifest(): {
  version: number;
  installedAt: string;
  components: string[];
  files: { path: string; action: string; marker?: string; keys?: string[]; backup?: string }[];
} | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), "utf-8"));
  } catch {
    return null;
  }
}

export function countEntries(predicate: (e: { path: string; action: string }) => boolean): number {
  const m = readManifest();
  return m ? m.files.filter(predicate).length : 0;
}

/** Pre-create `~/.claude` so the claude-code writer resolves under the temp home. */
export function createAgentConfigDir(): string {
  const claudeDir = path.join(M.home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  return claudeDir;
}

/** Create a pre-existing agent instruction file under the temp home (for patching). */
export function createPatchFile(name: string): string {
  const p = path.join(M.home, name);
  fs.writeFileSync(p, "# existing content\n", "utf-8");
  return p;
}

/** Default skill root inside the temp home. */
export function defaultSkillRoot(): string {
  return path.join(M.home, ".claude", "skills");
}

/**
 * Install/clear a per-command execSync override. A test hook may return a value
 * to short-circuit a command, or throw to simulate a failure at a specific
 * command (e.g. a service-install failure). For `execFileSync` calls the hook
 * receives `file args.join(" ")`. Pass `null` to clear.
 */
export function setExecHook(fn: ((cmd: string, opts?: unknown) => unknown) | null): void {
  M.execHook = fn;
}

/** All child-process invocations intercepted since the last beforeEach reset. */
export function execLog(): ReadonlyArray<{
  kind: "execSync" | "execFileSync";
  cmd: string;
  file?: string;
  args?: string[];
  opts?: unknown;
}> {
  return M.execLog;
}

/** The repo root's packageManager pin (e.g. "pnpm@9.0.0") — derived, not hardcoded. */
export function repoPin(): string {
  return M.repoPin;
}
