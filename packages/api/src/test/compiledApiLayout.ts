/**
 * LAYOUT MODULE — "arrange that artifact into my scenario".
 *
 * The layout module owns everything about *placing* a published compiled api
 * package into the shape a scenario needs; it knows nothing about how that
 * package was compiled or published (that is the artifact module's job).
 *
 * Three adapters exist because three real scenarios exist:
 *
 *  - **workspace** — the compiled package must resolve the pnpm workspace, so
 *    it is arranged inside the workspace and the compiled output is reached
 *    through a symlink. Nothing in the layout is mutated.
 *  - **installed** — an installed package outside any workspace: the compiled
 *    output and the drizzle folder are REAL COPIES (a symlink would resolve
 *    back into the workspace and select the wrong migration branch).
 *  - **outside-workspace** — like the installed layout, but the drizzle copy
 *    is owned by the layout so the scenario may rewrite its own migration
 *    journal.
 *
 * Publish semantics never appear here; layout semantics never appear in the
 * artifact module.
 */
import { expect } from "vitest";
import { copyFileSync, cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  recordCompiledApiConsumption,
  resolveCompiledApiArtifact,
  type CompiledApiArtifact,
} from "./compiledApiArtifact.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

export type CompiledApiLayoutKind = "workspace" | "installed" | "outside-workspace";

export interface CompiledApiLayout {
  /** The private, writable directory that holds this scenario's arrangement. */
  layoutRoot: string;
  /** The directory that behaves as the compiled api package. */
  packageDir: string;
  /** The compiled output inside {@link packageDir}. */
  distDir: string;
  /** The compiled api entrypoint inside {@link packageDir}. */
  entrypoint: string;
  /** The migration folder inside {@link packageDir} (real copy outside the workspace). */
  drizzleDir: string;
  /** The artifact this layout was arranged from. */
  artifact: CompiledApiArtifact;
  /** Remove this layout's private arrangement. */
  cleanup(): void;
}

export interface CompiledApiLayoutOptions {
  /** Stable name of the consumer; defaults to the running test file. */
  consumer?: string;
  /** Root the layout is created in. When omitted the layout creates its own. */
  root?: string;
}

let layoutSequence = 0;

function currentConsumerName(fallback: string): string {
  try {
    const testPath = expect.getState().testPath;
    if (typeof testPath === "string" && testPath.length > 0) return basename(testPath);
  } catch {
    // Outside a test context the caller-provided name is used.
  }
  return fallback;
}

function copyPackageManifest(packageDir: string): void {
  copyFileSync(join(PACKAGE_ROOT, "package.json"), join(packageDir, "package.json"));
}

function linkNodeModules(packageDir: string): void {
  symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(packageDir, "node_modules"), "dir");
}

/**
 * Workspace layout: the arrangement lives inside the workspace so that
 * `getWorkspaceRoot()` resolves the repository, and the compiled output is
 * reached through a symlink — the shared artifact is never mutated.
 */
export function createWorkspaceApiLayout(options: CompiledApiLayoutOptions = {}): CompiledApiLayout {
  const artifact = resolveCompiledApiArtifact();
  const consumer = currentConsumerName(options.consumer ?? "workspace-consumer");
  const layoutRoot = join(
    artifact.runRoot,
    "layouts",
    `${consumer.replace(/[^a-zA-Z0-9._-]/g, "_")}-${process.pid}-${++layoutSequence}`,
  );
  rmSync(layoutRoot, { recursive: true, force: true });
  mkdirSync(layoutRoot, { recursive: true });

  const distDir = join(layoutRoot, basename(artifact.distDir));
  symlinkSync(artifact.distDir, distDir, "dir");
  const drizzleDir = join(layoutRoot, "drizzle");
  symlinkSync(join(PACKAGE_ROOT, "drizzle"), drizzleDir, "dir");
  copyPackageManifest(layoutRoot);
  linkNodeModules(layoutRoot);

  recordCompiledApiConsumption(artifact, { name: consumer, layout: "workspace" });
  return {
    layoutRoot,
    packageDir: layoutRoot,
    distDir,
    entrypoint: artifact.entrypoint,
    drizzleDir,
    artifact,
    cleanup: () => rmSync(layoutRoot, { recursive: true, force: true }),
  };
}

function createCopiedLayout(
  kind: Exclude<CompiledApiLayoutKind, "workspace">,
  packageDirName: string,
  options: CompiledApiLayoutOptions,
): CompiledApiLayout {
  const artifact = resolveCompiledApiArtifact();
  const consumer = currentConsumerName(options.consumer ?? kind);
  const ownsRoot = !options.root;
  const layoutRoot = options.root ?? join(tmpdir(), `orcy-api-${kind}-${process.pid}-${Date.now()}`);
  mkdirSync(layoutRoot, { recursive: true });
  const packageDir = join(layoutRoot, packageDirName);
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });

  // Real copies: a symlink would resolve back into the workspace and select
  // the workspace migration branch instead of the package's own folder.
  const distDir = join(packageDir, "dist");
  const drizzleDir = join(packageDir, "drizzle");
  try {
    cpSync(artifact.realDistDir, distDir, { recursive: true });
    cpSync(join(PACKAGE_ROOT, "drizzle"), drizzleDir, { recursive: true, dereference: true });
    copyPackageManifest(packageDir);
    linkNodeModules(packageDir);
  } catch (error) {
    // A failed assembly must not leak a layout the caller never received.
    rmSync(packageDir, { recursive: true, force: true });
    if (ownsRoot) rmSync(layoutRoot, { recursive: true, force: true });
    throw error;
  }

  recordCompiledApiConsumption(artifact, { name: consumer, layout: kind });
  return {
    layoutRoot,
    packageDir,
    distDir,
    entrypoint: join(distDir, "index.js"),
    drizzleDir,
    artifact,
    cleanup: () => {
      rmSync(packageDir, { recursive: true, force: true });
      if (ownsRoot) rmSync(layoutRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Installed layout: a package outside any workspace, assembled from real
 * copies of the compiled output and the migration folder.
 */
export function createInstalledApiLayout(options: CompiledApiLayoutOptions = {}): CompiledApiLayout {
  return createCopiedLayout("installed", "installed", options);
}

/**
 * Outside-workspace layout: like the installed layout, but the scenario owns
 * its migration folder and may rewrite the journal inside it.
 */
export function createOutsideWorkspaceApiLayout(options: CompiledApiLayoutOptions = {}): CompiledApiLayout {
  return createCopiedLayout("outside-workspace", "package", options);
}
