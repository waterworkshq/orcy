import { beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/** One native compiler output per suite, kept intact until its children exit. */
export function useCompiledApi(): { distDir: string; entrypoint: string } {
  const fixture = { distDir: "", entrypoint: "" };
  let packageDir: string | undefined;

  beforeAll(() => {
    // Stay inside the workspace for the workspace migration branch, and
    // inside ignored dist/ so the fixture never becomes a source input.
    mkdirSync(join(PACKAGE_ROOT, "dist"), { recursive: true });
    packageDir = mkdtempSync(join(PACKAGE_ROOT, "dist", ".startup-"));
    fixture.distDir = join(packageDir, "dist");
    fixture.entrypoint = join(fixture.distDir, "index.js");
    try {
      // Compile directly here: copying shared dist/ can snapshot a concurrent
      // emitter's truncated file. Corepack follows the root packageManager pin.
      execFileSync("corepack", ["pnpm", "--filter", "@orcy/api", "build", "--outDir", fixture.distDir], {
        cwd: WORKSPACE_ROOT,
        stdio: "pipe",
        timeout: 120_000,
      });
      copyFileSync(join(PACKAGE_ROOT, "package.json"), join(packageDir, "package.json"));
      symlinkSync(join(PACKAGE_ROOT, "drizzle"), join(packageDir, "drizzle"), "dir");
      symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(packageDir, "node_modules"), "dir");
    } catch (error) {
      rmSync(packageDir, { recursive: true, force: true });
      throw error;
    }
  }, 120_000);

  afterAll(() => {
    if (packageDir) rmSync(packageDir, { recursive: true, force: true });
  });

  return fixture;
}
