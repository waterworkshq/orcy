import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { InstallContext } from "./context.js";
import { createShims, editShellRc } from "./path-shim.js";
import { record } from "./manifest.js";

const REPO_URL_BASE = "https://github.com/waterworkshq/orcy";
const ARCHIVE_URL = `${REPO_URL_BASE}/archive/refs/heads/main.tar.gz`;

export interface InstallOptions {
	local?: boolean;
}

function rmRf(p: string): void {
	if (!fs.existsSync(p)) return;
	if (process.platform === "win32") {
		execSync(`rmdir /s /q "${p}"`, { stdio: "ignore" });
	} else {
		execSync(`rm -rf "${p}"`, { stdio: "ignore" });
	}
}

function getInstallerDir(): string {
	return path.resolve(import.meta.dirname, "..");
}

function ensurePnpm(): void {
	try {
		execSync("pnpm --version", { stdio: "pipe" });
	} catch {
		console.log("    pnpm not found. Installing pnpm via npm...");
		execSync("npm install -g pnpm", { stdio: "pipe" });
		try {
			execSync("pnpm --version", { stdio: "pipe" });
			console.log("    pnpm installed");
		} catch {
			throw new Error(
				"Failed to install pnpm. Please install pnpm manually: npm install -g pnpm",
			);
		}
	}
}

function buildFromArchive(ctx: InstallContext): void {
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

	// Ensure pnpm is available
	ensurePnpm();

	// Install dependencies and build
	console.log("    Installing dependencies...");
	try {
		execSync("pnpm install --frozen-lockfile", { cwd: srcDir, stdio: "pipe" });
	} catch {
		console.log("    Frozen lockfile failed, trying pnpm install...");
		execSync("pnpm install", { cwd: srcDir, stdio: "pipe" });
	}

	console.log("    Building packages...");
	execSync("pnpm -r build", { cwd: srcDir, stdio: "pipe" });
	console.log("    Build complete");
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
): void {
	if (Object.keys(allDeps).length === 0) return;

	const pkgJson = path.join(orcyHome, "package.json");
	const existingPkg = fs.existsSync(pkgJson)
		? JSON.parse(fs.readFileSync(pkgJson, "utf-8"))
		: { private: true, dependencies: {}, pnpm: { onlyBuiltDependencies: ['better-sqlite3'] } };
	existingPkg.dependencies = { ...existingPkg.dependencies, ...allDeps };
	if (!existingPkg.pnpm) existingPkg.pnpm = {};
	if (!existingPkg.pnpm.onlyBuiltDependencies) existingPkg.pnpm.onlyBuiltDependencies = [];
	if (!existingPkg.pnpm.onlyBuiltDependencies.includes('better-sqlite3')) {
		existingPkg.pnpm.onlyBuiltDependencies.push('better-sqlite3');
	}
	fs.writeFileSync(pkgJson, JSON.stringify(existingPkg, null, 2));

	console.log("    Installing runtime dependencies...");
	execSync("pnpm install --prod", { cwd: orcyHome, stdio: "pipe" });
	console.log("    Runtime dependencies installed");
}

function installBuiltPackages(
	ctx: InstallContext,
	components: string[],
	srcDir: string,
): void {
	const nodeModules = path.join(ctx.orcyHome, "node_modules");
	if (!fs.existsSync(nodeModules))
		fs.mkdirSync(nodeModules, { recursive: true });

	// Phase 1: Collect runtime deps from all selected components
	// and install them via pnpm into a temp directory, then copy
	// the resolved packages into orcyHome/node_modules.
	const allDeps: Record<string, string> = {};
	for (const comp of components) {
		const srcPkgJson = path.join(srcDir, "packages", comp, "package.json");
		Object.assign(allDeps, collectDeps(srcPkgJson));
	}
	installRuntimeDeps(ctx.orcyHome, allDeps);

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
	const installComponents = components.includes('api')
		? components
		: ['api', ...components];

	if (options.local) {
		const localSrcDir = path.resolve(getInstallerDir(), "..", "..");
		console.log(`    Using local build from ${localSrcDir}`);
		if (fs.existsSync(path.join(localSrcDir, "packages", "cli", "dist"))) {
			installBuiltPackages(ctx, installComponents, localSrcDir);
		} else {
			console.log("    Local dist not found. Building from local source...");
			ensurePnpm();
			try {
				execSync("pnpm install --frozen-lockfile", {
					cwd: localSrcDir,
					stdio: "pipe",
				});
			} catch {
				execSync("pnpm install", { cwd: localSrcDir, stdio: "pipe" });
			}
			execSync("pnpm -r build", { cwd: localSrcDir, stdio: "pipe" });
			installBuiltPackages(ctx, installComponents, localSrcDir);
		}
	} else {
		buildFromArchive(ctx);
		const srcDir = path.join(ctx.orcyHome, "src", "orcy");
		installBuiltPackages(ctx, installComponents, srcDir);
	}

	createShims(ctx, installComponents);
	editShellRc(ctx);
	console.log(`    PATH shims written to ${ctx.binDir}/`);
}
