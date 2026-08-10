/**
 * P6.1 — migrate post-rename hardening (B6).
 *
 * Tests that migrateLegacyInstallation (1) rewrites manifest paths ~/.kanban →
 * ~/.orcy immediately after the rename (so post-migrate uninstall finds them),
 * and (2) survives a throwing markdown-rewrite step without aborting migration.
 *
 * MOCK BOUNDARY: imports ./helpers/setup.js FIRST (mocks @orcy/shared ORCY_PATHS,
 * node:child_process, fetch). Real node:fs operates on the temp home. The migrate
 * gate requires ~/.orcy to NOT exist, so each test clears the harness-created
 * orcyHome before seeding the legacy ~/.kanban fixture.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { tempHome, orcyHome, readManifest, setExecHook } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { migrateLegacyInstallation } from "../src/lifecycle.js";
import type { Manifest } from "../src/manifest.js";

const kanbanHome = () => path.join(tempHome(), ".kanban");

/** Seed a legacy ~/.kanban/install-manifest.json with the given file entries. */
function seedLegacyManifest(files: { path: string; action: string }[]): void {
  fs.mkdirSync(kanbanHome(), { recursive: true });
  const manifest: Manifest = {
    version: 1,
    installedAt: "2024-01-01T00:00:00Z",
    components: ["cli", "api"],
    files: files as Manifest["files"],
  };
  fs.writeFileSync(
    path.join(kanbanHome(), "install-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

afterEach(() => {
  fs.rmSync(kanbanHome(), { recursive: true, force: true });
  fs.rmSync(orcyHome(), { recursive: true, force: true });
  setExecHook(null);
});

describe("migrateLegacyInstallation — post-rename hardening (B6)", () => {
  it("rewrites manifest paths ~/.kanban → ~/.orcy immediately after the rename", async () => {
    fs.rmSync(orcyHome(), { recursive: true, force: true });
    seedLegacyManifest([
      { path: path.join(kanbanHome(), "bin", "orcy"), action: "created" },
      { path: path.join(kanbanHome(), "node_modules", "@orcy", "api"), action: "created" },
    ]);

    const result = await migrateLegacyInstallation(getContext());
    expect(result).toBe(true);

    // ~/.kanban is gone; ~/.orcy exists.
    expect(fs.existsSync(kanbanHome())).toBe(false);
    expect(fs.existsSync(orcyHome())).toBe(true);

    // Every manifest path rewritten — none still reference .kanban.
    const m = readManifest();
    expect(m).not.toBeNull();
    expect(m!.files.length).toBeGreaterThanOrEqual(2);
    for (const entry of m!.files) {
      expect(entry.path, `path still references .kanban: ${entry.path}`).not.toContain(".kanban");
    }
  });

  it("survives a throwing markdown-rewrite step without aborting migration", async () => {
    fs.rmSync(orcyHome(), { recursive: true, force: true });
    // Seed a fenced AGENTS.md entry pointing at a DIRECTORY (not a file).
    // After rename it lands at ~/.orcy/AGENTS.md; readFileSync on a directory
    // throws EISDIR — the hardened step-6 try/catch must catch it and continue.
    const agentsPath = path.join(kanbanHome(), "AGENTS.md");
    fs.mkdirSync(agentsPath, { recursive: true });
    seedLegacyManifest([
      { path: path.join(kanbanHome(), "bin", "orcy"), action: "created" },
      { path: agentsPath, action: "fenced" },
    ]);

    // Migration must NOT re-throw — the fenced-block failure is caught.
    const result = await migrateLegacyInstallation(getContext());
    expect(result).toBe(true);

    // The path rewrite (which runs before step 6) still took effect.
    const m = readManifest();
    expect(m).not.toBeNull();
    for (const entry of m!.files) {
      expect(entry.path).not.toContain(".kanban");
    }
  });
});
