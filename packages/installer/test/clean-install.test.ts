/**
 * Clean install, end to end: the documented bootstrap → standalone installer →
 * wizard → installed entry points, with REAL dependency resolution.
 *
 * OPT-IN — it needs the network and builds the whole source twice (minutes).
 * Every other installer suite fakes the package manager, and a fake package
 * manager cannot establish a dependency closure; this one runs the real thing.
 * Run it once per supported Node major, on that major's own node:
 *
 *   ORCY_INSTALL_E2E=1   corepack pnpm --filter @orcy/installer exec vitest run test/clean-install.test.ts
 *   ORCY_INSTALL_E2E=all corepack pnpm ...                                    (also installs + smokes the CLI)
 *
 * The archive installed from is `git archive HEAD` — commit first — or the
 * tarball named by ORCY_INSTALL_E2E_ARCHIVE.
 *
 * What is REAL: `sh install.sh` itself, node, corepack / npx, the source-pinned
 * pnpm resolving against the registry and lockfile, tar, `pnpm -r build`, the
 * wizard, and the installed API and MCP processes.
 * What is CONTROLLED: a disposable HOME (no ambient Orcy workspace, config,
 * shell rc, credentials or database), a stub `curl` that serves a controlled
 * archive of this checkout in place of the GitHub download, and stub service
 * managers (`systemctl` / `launchctl`) that record every call and refuse it.
 * Agent registration is pointed at a closed port, so nothing can reach a live
 * Orcy. Nothing outside the disposable HOME is read or written except the
 * package registries.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const MODE = process.env.ORCY_INSTALL_E2E;
const MINUTE = 60_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const scratchDirs: string[] = [];
const children: ChildProcess[] = [];

/** Resolve a real binary through the test process's own PATH. */
function resolveBin(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep scanning
    }
  }
  throw new Error(`cannot resolve real ${name} on PATH`);
}

function writeStub(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

const tail = (s: string, n = 4000): string => (s.length > n ? `…${s.slice(-n)}` : s);

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(
  what: string,
  ready: () => boolean | Promise<boolean>,
  timeoutMs: number,
  diagnostics: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what}.\n${diagnostics()}`);
}

/** Symlinks under `dir` whose target lies outside `dir` — e.g. back into a workspace. */
function symlinksEscaping(dir: string): string[] {
  const escaping: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        if (!fs.realpathSync(full).startsWith(dir + path.sep)) escaping.push(full);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return escaping;
}

interface Scenario {
  home: string;
  orcyHome: string;
  env: NodeJS.ProcessEnv;
  serviceLog: string;
}

/** Disposable HOME + controlled PATH: stubs, then this test's own node, then coreutils. */
function buildScenario(archive: string, apiUrl: string): Scenario {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orcy-clean-install-"));
  scratchDirs.push(home);
  const stubDir = path.join(home, "stubs");
  const serviceLog = path.join(home, "service-manager.log");
  fs.mkdirSync(stubDir);

  // Serves the controlled archive wherever install.sh or the wizard downloads.
  writeStub(
    stubDir,
    "curl",
    `out=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
cp "${archive}" "$out"
`,
  );
  // Service managers: record and refuse. A real manager is never reached.
  for (const manager of ["systemctl", "launchctl"]) {
    writeStub(stubDir, manager, `echo "${manager} $*" >> "${serviceLog}"\nexit 1`);
  }
  // No bare pnpm, no npm: only the source-pinned runner may run.
  for (const banned of ["pnpm", "npm"]) {
    writeStub(stubDir, banned, `echo "FORBIDDEN ${banned} $*" >> "${serviceLog}"\nexit 1`);
  }

  return {
    home,
    orcyHome: path.join(home, ".orcy"),
    serviceLog,
    env: {
      HOME: home,
      PATH: `${stubDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ORCY_API_URL: apiUrl,
    },
  };
}

function dependenciesOf(manifest: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(manifest, "utf-8")).dependencies;
}

/** The handed-off installer must run with NO workspace and NO runtime node_modules anywhere near it. */
function assertStandaloneInstaller(s: Scenario): void {
  const orcy = s.orcyHome;
  const moved = ["src", "node_modules"].map((dir) => [path.join(orcy, dir), path.join(orcy, `${dir}.aside`)]);
  for (const [from, to] of moved) fs.renameSync(from, to);
  try {
    const entry = path.join(orcy, "installer", "dist", "index.js");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [entry, ...args], { env: s.env, cwd: "/", encoding: "utf8" });
    const version = run("--version");
    expect(version.status, tail(`${version.stdout}\n${version.stderr}`)).toBe(0);
    expect(version.stdout.trim()).toBe("1.0.0");
    const list = run("list");
    expect(list.status, tail(`${list.stdout}\n${list.stderr}`)).toBe(0);
    expect(list.stdout).toMatch(/^Installed: /m);
  } finally {
    for (const [from, to] of moved) fs.renameSync(to, from);
  }
}

/** Start the installed API through its PATH shim on a disposable port; it must come up and exit cleanly. */
async function smokeApi(s: Scenario): Promise<void> {
  const port = await freePort();
  const child = spawn(path.join(s.orcyHome, "bin", "orcy-api"), [], {
    // cwd is the orcy home so the generated .env (JWT secrets) is loaded; the
    // explicit PORT / HOST win over it (dotenv never overrides the environment).
    cwd: s.orcyHome,
    env: { ...s.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d));
  child.stderr.on("data", (d: Buffer) => (output += d));

  await waitFor(
    "GET /health to answer 200",
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    },
    90_000,
    () => tail(output),
  );
  child.kill("SIGTERM");
  await waitFor("the API to exit on SIGTERM", () => child.exitCode !== null, 15_000, () => tail(output));
  expect(child.exitCode, tail(output)).toBe(0);
}

type Rpc = { id?: number; result?: { serverInfo?: { name?: string }; tools?: unknown[] } };

/** Drive the installed MCP server through its PATH shim over stdio: initialize, then list tools. */
async function smokeMcp(s: Scenario): Promise<void> {
  const child = spawn(path.join(s.orcyHome, "bin", "orcy-mcp"), [], {
    cwd: s.home,
    env: s.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const replies: Rpc[] = [];
  let log = "";
  // A `data` event can end mid-line: parse complete lines and keep the rest.
  let pending = "";
  child.stdout.on("data", (d: Buffer) => {
    pending += d.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      try {
        replies.push(JSON.parse(line));
      } catch {
        log += `${line}\n`;
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => (log += d));
  const reply = (id: number) => replies.find((m) => m.id === id);
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clean-install-test", version: "0.0.0" },
    },
  });
  await waitFor("the initialize reply", () => reply(1) !== undefined, 30_000, () => tail(log));
  expect(reply(1)?.result?.serverInfo?.name).toBe("orcy-mcp-server");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await waitFor("the tools/list reply", () => reply(2) !== undefined, 30_000, () => tail(log));
  expect(reply(2)?.result?.tools?.length ?? 0).toBeGreaterThan(0);

  child.stdin.end();
  await waitFor("the MCP server to exit on EOF", () => child.exitCode !== null, 15_000, () => tail(log));
  expect(child.exitCode, tail(log)).toBe(0);
}

describe.skipIf(!MODE)("clean install (real pinned pnpm, real build, disposable destination)", () => {
  afterAll(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  }, 5 * MINUTE);

  it(
    "reaches a working installed runtime from the documented bootstrap",
    async () => {
      // A controlled archive of this checkout stands in for the GitHub download.
      let archive = process.env.ORCY_INSTALL_E2E_ARCHIVE
        ? path.resolve(process.env.ORCY_INSTALL_E2E_ARCHIVE)
        : undefined;
      if (!archive) {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orcy-clean-install-archive-"));
        scratchDirs.push(scratch);
        archive = path.join(scratch, "orcy.tar.gz");
        const fd = fs.openSync(archive, "w");
        const packed = spawnSync(
          resolveBin("git"),
          ["archive", "--format=tar.gz", "--prefix=orcy-main/", "HEAD"],
          { cwd: REPO_ROOT, stdio: ["ignore", fd, "pipe"] },
        );
        fs.closeSync(fd);
        expect(packed.status, String(packed.stderr)).toBe(0);
      }

      // Agent registration must not be able to reach a live Orcy.
      const s = buildScenario(archive, `http://127.0.0.1:${await freePort()}`);
      const components = MODE === "all" ? "cli,api,mcp" : "api,mcp";
      const run = spawnSync(
        resolveBin("sh"),
        [
          path.join(REPO_ROOT, "install.sh"),
          "--yes",
          `--components=${components}`,
          "--mcp-clients=",
          "--patch-files=",
          "--skill-roots=",
        ],
        // Empty stdin: exactly what `curl … | bash` leaves for the installer.
        { env: s.env, cwd: s.home, input: "", encoding: "utf8", timeout: 30 * MINUTE, maxBuffer: 256 * 1024 * 1024 },
      );
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.status, tail(output)).toBe(0);
      expect(output).toMatch(/installation complete/i);
      // The bootstrap never speaks for a wizard that has not run yet.
      expect(output).not.toMatch(/setup complete/i);
      // Nothing forbidden ran, and the service path stopped at the stub.
      const serviceLog = fs.readFileSync(s.serviceLog, "utf8");
      expect(serviceLog).not.toMatch(/FORBIDDEN/);
      expect(serviceLog).toMatch(/^systemctl --user daemon-reload$|^launchctl /m);

      // --- The destination is a standalone install, not a workspace view. ---
      for (const manifest of [s.orcyHome, path.join(s.orcyHome, "installer")]) {
        const deps = Object.values(dependenciesOf(path.join(manifest, "package.json")));
        expect(deps.filter((spec) => spec.startsWith("workspace:")), manifest).toEqual([]);
      }
      for (const dir of [path.join(s.orcyHome, "installer"), path.join(s.orcyHome, "node_modules")]) {
        expect(symlinksEscaping(dir), `symlinks escaping ${dir}`).toEqual([]);
      }
      for (const name of ["api", "mcp", "shared", "daemon", ...(MODE === "all" ? ["cli"] : [])]) {
        const dir = path.join(s.orcyHome, "node_modules", "@orcy", name);
        expect(fs.lstatSync(dir).isSymbolicLink(), `${name} must be a real package copy`).toBe(false);
        expect(fs.existsSync(path.join(dir, "dist", "index.js")), `${name}/dist/index.js`).toBe(true);
      }
      // The handed-off installer runs the dependency versions the workspace
      // lockfile resolved for the source just built — not a fresh resolution
      // of the manifest's version ranges.
      const source = path.join(s.orcyHome, "src", "orcy", "packages", "installer");
      const versionOf = (root: string, name: string): string =>
        JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf-8")).version;
      for (const name of Object.keys(dependenciesOf(path.join(source, "package.json")))) {
        expect(versionOf(path.join(s.orcyHome, "installer"), name), name).toBe(versionOf(source, name));
      }

      // --- Entry points. ---
      assertStandaloneInstaller(s);
      await smokeApi(s);
      await smokeMcp(s);
      if (MODE === "all") {
        const cli = spawnSync(path.join(s.orcyHome, "bin", "orcy"), ["--help"], {
          env: s.env,
          cwd: s.home,
          encoding: "utf8",
        });
        expect(cli.status, tail(`${cli.stdout}\n${cli.stderr}`)).toBe(0);
        expect(cli.stdout).toMatch(/Usage:/);
      }
    },
    45 * MINUTE,
  );
});
