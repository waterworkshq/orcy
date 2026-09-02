import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import type { InstallContext } from "./context.js";
import { createShims, editShellRc } from "./path-shim.js";
import { record, hashFile } from "./manifest.js";

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

/** Run pnpm through the resolved runner with an argument array (no shell string). */
function runPnpm(runner: PnpmRunner, args: string[], options: { cwd: string }): void {
  execFileSync(runner.command, [...runner.baseArgs, ...args], {
    cwd: options.cwd,
    stdio: "pipe",
  });
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

function collectDeps(packageJsonPath: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return pkg.dependencies ?? {};
  } catch {
    return {};
  }
}

function installRuntimeDeps(
  orcyHome: string,
  allDeps: Record<string, string>,
  runner: PnpmRunner,
): void {
  if (Object.keys(allDeps).length === 0) return;

  const pkgJson = path.join(orcyHome, "package.json");
  const existingPkg = fs.existsSync(pkgJson)
    ? JSON.parse(fs.readFileSync(pkgJson, "utf-8"))
    : { private: true, dependencies: {}, pnpm: { onlyBuiltDependencies: ["better-sqlite3"] } };
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

  // Phase 1: Collect runtime deps from all selected components
  // and install them via pnpm into a temp directory, then copy
  // the resolved packages into orcyHome/node_modules.
  const allDeps: Record<string, string> = {};
  for (const comp of components) {
    const srcPkgJson = path.join(srcDir, "packages", comp, "package.json");
    Object.assign(allDeps, collectDeps(srcPkgJson));
  }
  installRuntimeDeps(ctx.orcyHome, allDeps, runner);

  for (const comp of components) {
    const srcDistDir = path.join(srcDir, "packages", comp, "dist");
    const destDir = path.join(nodeModules, "@orcy", comp);

    if (!fs.existsSync(srcDistDir)) {
      console.warn(`    No dist found for @orcy/${comp}, skipping`);
      continue;
    }

    rmRf(destDir);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDistDir, path.join(destDir, "dist"), { recursive: true });

    const srcPkgJson = path.join(srcDir, "packages", comp, "package.json");
    if (fs.existsSync(srcPkgJson)) {
      fs.cpSync(srcPkgJson, path.join(destDir, "package.json"));
    }

    record({ path: destDir, action: "created" });
    console.log(`    Installed @orcy/${comp}`);
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
