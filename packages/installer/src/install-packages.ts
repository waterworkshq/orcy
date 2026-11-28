import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import type { InstallContext } from "./context.js";
import { createShims, editShellRc } from "./path-shim.js";
import { record, hashFile } from "./manifest.js";
import { shellQuote, shellWord } from "./shell-quote.js";

const REPO_URL_BASE = "https://github.com/waterworkshq/orcy";
const ARCHIVE_URL = `${REPO_URL_BASE}/archive/refs/heads/main.tar.gz`;

export interface InstallOptions {
  local?: boolean;
}

/** A resolved, version-pinned pnpm invocation prefix. */
interface PnpmRunner {
  command: "corepack" | "npx";
  baseArgs: string[];
}

function rmRf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function getInstallerDir(): string {
  return path.resolve(import.meta.dirname, "..");
}

/**
 * Extract the exact pnpm version from a `packageManager` field. Only a strict
 * `pnpm@<version>` pin (optionally with a corepack integrity hash suffix) is
 * accepted; ranges, other managers, and unpinned specs fail closed.
 */
function parsePinnedPnpmVersion(spec: unknown): string {
  if (typeof spec !== "string") {
    throw new Error(
      `Source tree packageManager field must pin an exact pnpm version (e.g. "pnpm@9.0.0"); got: ${JSON.stringify(spec ?? null)}`,
    );
  }
  const match = spec.match(/^pnpm@(\d+\.\d+\.\d+)(\+[A-Za-z0-9._-]+)?$/);
  if (!match) {
    throw new Error(
      `Source tree packageManager field must pin an exact pnpm version (e.g. "pnpm@9.0.0"); got: ${spec}`,
    );
  }
  return match[1];
}

/**
 * Resolve how to run the source tree's pinned pnpm: prefer corepack (ships with
 * Node), fall back to an ephemeral `npx --yes pnpm@<version>` (no global pnpm is
 * installed or mutated). Fails closed if neither can run the pinned version.
 */
function resolvePnpmRunner(sourceRoot: string): PnpmRunner {
  let spec: unknown;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf-8"));
    spec = pkg.packageManager;
  } catch {
    spec = undefined;
  }
  const version = parsePinnedPnpmVersion(spec);
  const pin = `pnpm@${version}`;
  try {
    execFileSync("corepack", [pin, "--version"], { stdio: "pipe" });
    return { command: "corepack", baseArgs: [pin] };
  } catch {
    try {
      execFileSync("npx", ["--yes", pin, "--version"], { stdio: "pipe" });
      return { command: "npx", baseArgs: ["--yes", pin] };
    } catch {
      throw new Error(
        `Unable to run the pinned pnpm (${pin}) via corepack or npx. Install corepack (bundled with Node.js) or npm, then retry.`,
      );
    }
  }
}

/**
 * Run pnpm through the resolved runner with an argument array (no shell string).
 * The child's output is captured, and a failure must still say why: the error
 * carries the exit status (or the spawn code when the command never ran) and
 * pnpm's own `ERR_PNPM_*` identifier when it printed one. The captured output
 * itself is not forwarded and the raw child error is not attached as `cause`:
 * both can hold credential-bearing URLs or values printed by lifecycle scripts,
 * and this error ends up in terminals, logs and pasted transcripts.
 */
function runPnpm(runner: PnpmRunner, args: string[], options: { cwd: string }): void {
  const argv = [...runner.baseArgs, ...args];
  // Quoted word by word: a path argument may contain spaces or shell syntax.
  const command = [runner.command, ...argv].map(shellWord).join(" ");
  try {
    execFileSync(runner.command, argv, { cwd: options.cwd, stdio: "pipe" });
  } catch (err) {
    const { status, signal, code, stdout, stderr } = err as {
      status?: number | null;
      signal?: string;
      code?: string;
      stdout?: unknown;
      stderr?: unknown;
    };
    const captured = [stdout, stderr]
      .filter((stream): stream is Buffer => Buffer.isBuffer(stream))
      .map((stream) => stream.toString("utf8"))
      .join("\n");
    const pnpmCode = captured.match(/\bERR_PNPM_[A-Z0-9_]+\b/)?.[0];
    // No exit status means the command never ran: report the spawn code instead.
    const outcome =
      status != null ? `exit ${status}` : (code ?? (signal ? `signal ${signal}` : "no exit status"));
    // oxlint-disable-next-line preserve-caught-error -- the raw child error carries the captured output
    throw new Error(
      `Pinned pnpm failed (${outcome}${pnpmCode ? `, ${pnpmCode}` : ""}): ${command}\n` +
        // With the working directory: pnpm operates on the project it is run
        // in, so the command must not be retried from wherever the user is.
        `Re-run it where it ran to see pnpm's full output: (cd ${shellQuote(options.cwd)} && ${command})`,
    );
  }
}

function buildFromArchive(ctx: InstallContext): PnpmRunner {
  const srcDir = path.join(ctx.orcyHome, "src", "orcy");
  const cacheDir = path.join(ctx.orcyHome, "cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  if (fs.existsSync(srcDir)) rmRf(srcDir);
  fs.mkdirSync(srcDir, { recursive: true });

  const archivePath = path.join(cacheDir, "orcy.tar.gz");
  console.log("    Downloading source from GitHub...");
  execSync(`curl -fSL "${ARCHIVE_URL}" -o "${archivePath}.tmp"`, {
    stdio: "pipe",
  });
  fs.renameSync(archivePath + ".tmp", archivePath);
  execSync(`tar -xzf "${archivePath}" -C "${srcDir}" --strip-components=1`, {
    stdio: "pipe",
  });
  console.log("    Source extracted to ~/.orcy/src/");

  // Run every build command on the version pinned by the extracted source.
  const runner = resolvePnpmRunner(srcDir);

  // Install dependencies and build
  console.log("    Installing dependencies...");
  try {
    runPnpm(runner, ["install", "--frozen-lockfile"], { cwd: srcDir });
  } catch {
    console.log("    Frozen lockfile failed, trying pnpm install...");
    runPnpm(runner, ["install"], { cwd: srcDir });
  }

  console.log("    Building packages...");
  runPnpm(runner, ["-r", "build"], { cwd: srcDir });
  console.log("    Build complete");
  return runner;
}

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A package's manifest, or an empty one when it is missing or unreadable. */
function readManifest(pkgDir: string): PackageManifest {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
  } catch {
    return {};
  }
}

/** A dependency on another package of the same pnpm workspace. */
const isWorkspaceSpec = (spec: unknown): spec is string =>
  typeof spec === "string" && spec.startsWith("workspace:");

/**
 * A dependency name becomes a directory name under `node_modules`, so only a
 * real npm package name is usable: nothing that can climb out of it.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * What the selected components need at run time from a source tree that is NOT
 * their workspace: the registry dependencies to install into the destination
 * manifest, and the `workspace:` packages to copy beside the components. The
 * destination has no workspace, so a `workspace:` spec can never resolve there.
 * A built component loads a workspace package whichever manifest section lists
 * it, so both `dependencies` and `devDependencies` are read; registry
 * devDependencies stay out (the install is production-only).
 */
function resolveRuntimeClosure(
  srcDir: string,
  components: string[],
): { registryDeps: Record<string, string>; workspacePackages: [name: string, pkgDir: string][] } {
  const packagesDir = path.join(srcDir, "packages");
  const dirByName = new Map<string, string>();
  for (const dir of fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : []) {
    const pkgDir = path.join(packagesDir, dir);
    const { name } = readManifest(pkgDir);
    if (name) dirByName.set(name, pkgDir);
  }

  const componentDirs = components.map((comp) => path.join(packagesDir, comp));
  const workspacePackages: [string, string][] = [];
  // Breadth-first from the components: every workspace package they load,
  // directly or through another workspace package.
  const queue = [...componentDirs];
  for (const pkgDir of queue) {
    const { dependencies = {}, devDependencies = {} } = readManifest(pkgDir);
    for (const [name, spec] of Object.entries({ ...dependencies, ...devDependencies })) {
      if (!isWorkspaceSpec(spec) || workspacePackages.some(([dep]) => dep === name)) continue;
      const depDir = dirByName.get(name);
      if (!depDir || !NPM_PACKAGE_NAME.test(name)) {
        throw new Error(
          `Workspace dependency "${name}" (required by ${path.basename(pkgDir)}) is not a package under ${packagesDir}`,
        );
      }
      // Checked here, before anything is installed or copied: an unbuilt
      // workspace package would otherwise surface only after the components
      // were already in place.
      if (!fs.existsSync(path.join(depDir, "dist"))) {
        throw new Error(`No dist found for workspace dependency ${name} (${depDir}); build it before installing`);
      }
      workspacePackages.push([name, depDir]);
      queue.push(depDir);
    }
  }

  // ponytail: registry ranges merge flat — one version per name in the
  // destination manifest; conflicting ranges between packages would need
  // nested node_modules.
  const registryDeps: Record<string, string> = {};
  // Workspace packages first, so a component's own range wins where they differ.
  for (const pkgDir of [...workspacePackages.map(([, dir]) => dir), ...componentDirs]) {
    for (const [name, spec] of Object.entries(readManifest(pkgDir).dependencies ?? {})) {
      if (!isWorkspaceSpec(spec)) registryDeps[name] = spec;
    }
  }
  return { registryDeps, workspacePackages };
}

/**
 * Copy a built workspace package (`dist/` + manifest) to `<nodeModules>/<name>`.
 * Returns the destination, or null when the package has no `dist/`.
 */
function copyBuiltPackage(pkgDir: string, name: string, nodeModules: string): string | null {
  const srcDist = path.join(pkgDir, "dist");
  if (!fs.existsSync(srcDist)) return null;
  const destDir = path.join(nodeModules, name);
  rmRf(destDir);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDist, path.join(destDir, "dist"), { recursive: true });
  const manifest = path.join(pkgDir, "package.json");
  if (fs.existsSync(manifest)) fs.cpSync(manifest, path.join(destDir, "package.json"));
  return destDir;
}

/** Remove every `workspace:` spec from a destination manifest's dependencies; tells whether there was one. */
function deleteWorkspaceSpecs(dependencies: Record<string, string> = {}): boolean {
  let removed = false;
  for (const [name, spec] of Object.entries(dependencies)) {
    if (isWorkspaceSpec(spec)) {
      delete dependencies[name];
      removed = true;
    }
  }
  return removed;
}

function installRuntimeDeps(
  orcyHome: string,
  allDeps: Record<string, string>,
  runner: PnpmRunner,
): void {
  const pkgJson = path.join(orcyHome, "package.json");
  const existingPkg = fs.existsSync(pkgJson)
    ? JSON.parse(fs.readFileSync(pkgJson, "utf-8"))
    : { private: true, dependencies: {}, pnpm: { onlyBuiltDependencies: ["better-sqlite3"] } };
  // The destination is not a workspace, so a `workspace:` spec can never
  // resolve here. Drop the ones an earlier installer wrote into this manifest
  // (it merged them straight from the components' manifests) — otherwise an
  // install that failed on them keeps failing after that was fixed. Every
  // other dependency, the user's included, is kept.
  const repaired = deleteWorkspaceSpecs(existingPkg.dependencies);
  if (Object.keys(allDeps).length === 0 && !repaired) return;

  existingPkg.dependencies = { ...existingPkg.dependencies, ...allDeps };
  if (!existingPkg.pnpm) existingPkg.pnpm = {};
  if (!existingPkg.pnpm.onlyBuiltDependencies) existingPkg.pnpm.onlyBuiltDependencies = [];
  if (!existingPkg.pnpm.onlyBuiltDependencies.includes("better-sqlite3")) {
    existingPkg.pnpm.onlyBuiltDependencies.push("better-sqlite3");
  }
  fs.writeFileSync(pkgJson, JSON.stringify(existingPkg, null, 2));

  console.log("    Installing runtime dependencies...");
  runPnpm(runner, ["install", "--prod"], { cwd: orcyHome });
  console.log("    Runtime dependencies installed");
  // G4: Record the package.json hash AFTER pnpm install so it reflects the
  // final on-disk state (pnpm may normalize package.json). Uninstall detects
  // user modifications and avoids destroying user-added deps.
  record({ path: pkgJson, action: "created", hash: hashFile(pkgJson) });
}

function installBuiltPackages(
  ctx: InstallContext,
  components: string[],
  srcDir: string,
  runner: PnpmRunner,
): void {
  const nodeModules = path.join(ctx.orcyHome, "node_modules");
  if (!fs.existsSync(nodeModules)) fs.mkdirSync(nodeModules, { recursive: true });

  // Phase 1: Install the registry dependencies of the selected components AND
  // of every workspace package they load, through the pinned pnpm into
  // orcyHome (package.json + node_modules).
  const closure = resolveRuntimeClosure(srcDir, components);
  installRuntimeDeps(ctx.orcyHome, closure.registryDeps, runner);

  // Phase 2: Copy the built components into orcyHome/node_modules/@orcy.
  for (const comp of components) {
    const destDir = copyBuiltPackage(path.join(srcDir, "packages", comp), `@orcy/${comp}`, nodeModules);
    if (!destDir) {
      console.warn(`    No dist found for @orcy/${comp}, skipping`);
      continue;
    }
    record({ path: destDir, action: "created" });
    console.log(`    Installed @orcy/${comp}`);
  }

  // The workspace packages those components load are copied the same way, as
  // real packages. They are deliberately not recorded: ownership is unchanged
  // — like the pnpm-installed registry packages, they leave with the components
  // in the node_modules sweep.
  for (const [name, pkgDir] of closure.workspacePackages) {
    copyBuiltPackage(pkgDir, name, nodeModules);
    console.log(`    Installed ${name}`);
  }

  if (components.includes("api")) {
    const srcUi = path.join(srcDir, "packages", "ui", "dist");
    const uiDistDir = path.join(nodeModules, "@orcy", "api", "ui");
    if (fs.existsSync(srcUi)) {
      fs.mkdirSync(ctx.uiDir, { recursive: true });
      fs.cpSync(srcUi, ctx.uiDir, { recursive: true });
      record({ path: ctx.uiDir, action: "created" });
      // Also copy into api package for standalone use
      if (!fs.existsSync(uiDistDir)) {
        fs.mkdirSync(path.dirname(uiDistDir), { recursive: true });
        fs.cpSync(srcUi, uiDistDir, { recursive: true });
      }
      console.log("    Bundled UI");
    }

    // Copy DB migration files so the API can initialize a fresh database
    const srcDrizzle = path.join(srcDir, "packages", "api", "drizzle");
    const destDrizzle = path.join(nodeModules, "@orcy", "api", "drizzle");
    if (fs.existsSync(srcDrizzle)) {
      rmRf(destDrizzle);
      fs.cpSync(srcDrizzle, destDrizzle, { recursive: true });
      record({ path: destDrizzle, action: "created" });
      console.log("    Bundled migrations");
    }
  }
}

export async function installPackages(
  ctx: InstallContext,
  components: string[],
  options: InstallOptions = {},
): Promise<void> {
  // Create run/log dirs
  fs.mkdirSync(ctx.runDir, { recursive: true });
  fs.mkdirSync(ctx.logsDir, { recursive: true });

  // API is the foundation — always install it regardless of component selection
  // This ensures the orcy-api shim and systemd service always have a working binary
  const installComponents = components.includes("api") ? components : ["api", ...components];

  if (options.local) {
    const localSrcDir = path.resolve(getInstallerDir(), "..", "..");
    console.log(`    Using local build from ${localSrcDir}`);
    // The local flow pins pnpm from the repository root's own packageManager.
    const runner = resolvePnpmRunner(localSrcDir);
    if (fs.existsSync(path.join(localSrcDir, "packages", "cli", "dist"))) {
      installBuiltPackages(ctx, installComponents, localSrcDir, runner);
    } else {
      console.log("    Local dist not found. Building from local source...");
      try {
        runPnpm(runner, ["install", "--frozen-lockfile"], { cwd: localSrcDir });
      } catch {
        runPnpm(runner, ["install"], { cwd: localSrcDir });
      }
      runPnpm(runner, ["-r", "build"], { cwd: localSrcDir });
      installBuiltPackages(ctx, installComponents, localSrcDir, runner);
    }
  } else {
    const runner = buildFromArchive(ctx);
    const srcDir = path.join(ctx.orcyHome, "src", "orcy");
    installBuiltPackages(ctx, installComponents, srcDir, runner);
  }

  createShims(ctx, installComponents);
  editShellRc(ctx);
  console.log(`    PATH shims written to ${ctx.binDir}/`);
}
