/**
 * P6.2 — v1→v2 manifest reconcile (G11).
 *
 * Tests reconcileManifest against fixtures of old-shape manifests: v2 no-op,
 * v1 duplicate dedup, v1 stale ~/.kanban path rewrite, versionless, missing
 * manifest, interactive decline, and non-interactive auto-apply.
 *
 * MOCK BOUNDARY: imports ./helpers/setup.js FIRST (mocks @orcy/shared ORCY_PATHS,
 * node:child_process, fetch, @clack/prompts). Real node:fs operates on the temp
 * home; os.homedir() resolves to the temp home via process.env.HOME.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { tempHome, manifestPath, readManifest } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { reconcileManifest } from "../src/reconcile.js";
import type { Manifest } from "../src/manifest.js";
import * as clack from "@clack/prompts";

const kanbanHome = () => path.join(tempHome(), ".kanban");

function writeManifestFile(m: Manifest): void {
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

/** Write a raw manifest JSON object (allows versionless / odd shapes). */
function writeRaw(obj: unknown): void {
  fs.writeFileSync(manifestPath(), JSON.stringify(obj, null, 2));
}

describe("reconcileManifest — v1→v2 (G11)", () => {
  it("(a) v2 manifest → no-op, unchanged", async () => {
    const original: Manifest = {
      version: 2,
      installedAt: "2024-01-01T00:00:00Z",
      components: ["cli"],
      files: [{ path: "/x/bin/orcy", action: "created" }],
    };
    writeManifestFile(original);

    const result = await reconcileManifest(getContext(), { interactive: false });
    expect(result).toBe(false);
    expect(readManifest()).toEqual(original);
  });

  it("(b) v1 with duplicate entries → deduped + version 2", async () => {
    const p = path.join(tempHome(), ".orcy", "bin", "orcy");
    writeManifestFile({
      version: 1,
      installedAt: "2024-01-01T00:00:00Z",
      components: ["cli"],
      files: [
        { path: p, action: "created" },
        { path: p, action: "created" }, // duplicate
        { path: p, action: "appended" }, // different action — kept
      ],
    });

    const result = await reconcileManifest(getContext(), { interactive: false });
    expect(result).toBe(true);

    const m = readManifest();
    expect(m!.version).toBe(2);
    const createdCount = m!.files.filter((e) => e.action === "created").length;
    expect(createdCount).toBe(1); // deduped
    expect(m!.files.filter((e) => e.action === "appended").length).toBe(1); // kept
  });

  it("(c) v1 with stale ~/.kanban paths → rewritten to ~/.orcy + version 2", async () => {
    const stale = path.join(kanbanHome(), "bin", "orcy");
    writeManifestFile({
      version: 1,
      installedAt: "2024-01-01T00:00:00Z",
      components: ["cli"],
      files: [
        { path: stale, action: "created" },
        { path: path.join(kanbanHome(), "node_modules", "@orcy", "api"), action: "created" },
      ],
    });

    const result = await reconcileManifest(getContext(), { interactive: false });
    expect(result).toBe(true);

    const m = readManifest();
    expect(m!.version).toBe(2);
    for (const entry of m!.files) {
      expect(entry.path).not.toContain(".kanban");
      expect(entry.path).toContain(".orcy");
    }
  });

  it("(d) versionless manifest → treated as v1, bumped to 2", async () => {
    // A real old manifest may predate the version field entirely.
    writeRaw({
      installedAt: "2023-01-01T00:00:00Z",
      components: ["cli"],
      files: [{ path: path.join(tempHome(), ".orcy", "bin", "orcy"), action: "created" }],
    });

    const result = await reconcileManifest(getContext(), { interactive: false });
    expect(result).toBe(true);
    expect(readManifest()!.version).toBe(2);
  });

  it("(e) no manifest → no-op", async () => {
    // beforeEach wiped orcyHome — no manifest exists.
    const result = await reconcileManifest(getContext(), { interactive: false });
    expect(result).toBe(false);
    expect(readManifest()).toBeNull();
  });

  it("(f) interactive decline → manifest unchanged", async () => {
    const original: Manifest = {
      version: 1,
      installedAt: "2024-01-01T00:00:00Z",
      components: ["cli"],
      files: [{ path: path.join(tempHome(), ".orcy", "bin", "orcy"), action: "created" }],
    };
    writeManifestFile(original);

    // User declines the reconcile prompt.
    vi.mocked(clack.confirm).mockResolvedValueOnce(false as never);

    const result = await reconcileManifest(getContext(), { interactive: true });
    expect(result).toBe(false);
    expect(readManifest()).toEqual(original); // unchanged
  });

  it("(g) non-interactive → auto-applies, version 2", async () => {
    writeManifestFile({
      version: 1,
      installedAt: "2024-01-01T00:00:00Z",
      components: ["cli"],
      files: [{ path: path.join(tempHome(), ".orcy", "bin", "orcy"), action: "created" }],
    });

    const result = await reconcileManifest(getContext(), { interactive: false });
    expect(result).toBe(true);
    expect(readManifest()!.version).toBe(2);
  });
});
