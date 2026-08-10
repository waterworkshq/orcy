/**
 * Cold-review Tier 2 — uninstall data-loss / retry-state safety.
 *
 * T2.3: a 'copied' skill with no recorded hash (legacy) is PRESERVED on uninstall
 *       (can't verify unchanged → assume possibly user-modified), not deleted.
 * T2.4: a G4 sweep failure (busy/locked node_modules) preserves the manifest so
 *       the user can retry, instead of deleting it while files remain.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import "./helpers/setup.js";
import { manifestPath, defaultSkillRoot } from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { uninstallAll } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { readManifest, writeManifest } from "../src/manifest.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("T2.3: legacy skill without a hash is preserved (no data loss)", () => {
  it("a 'copied' skill entry with no hash survives uninstall", async () => {
    await wizard({
      components: ["cli", "mcp"],
      mcpClients: [],
      patchFiles: [],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    });

    // Strip the hash from a copied skill entry to simulate a legacy (pre-P3.2) manifest.
    const m = readManifest()!;
    const copied = m.files.find((f) => f.action === "copied");
    expect(copied, "precondition: a copied skill entry exists").toBeTruthy();
    delete copied!.hash;
    writeManifest(m);

    const skillPath = copied!.path;
    expect(fs.existsSync(skillPath), "precondition: skill dir exists").toBe(true);

    await uninstallAll(getContext());

    // Preserved (not recursively deleted) — no hash means we can't confirm it's unchanged.
    expect(fs.existsSync(skillPath), "legacy skill preserved (no hash to verify)").toBe(true);
  });
});

describe("T2.4: sweep failure preserves the manifest for retry", () => {
  it("a node_modules sweep failure keeps the manifest on disk", async () => {
    await wizard({
      components: ["cli", "api"],
      mcpClients: [],
      patchFiles: [],
      skillRoots: [],
      interactive: false,
    });

    // Make rmSync throw for the node_modules sweep path only.
    const realRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, "rmSync").mockImplementation(((p: unknown, opts?: unknown) => {
      if (typeof p === "string" && p.endsWith("/node_modules")) {
        throw new Error("simulated busy sweep (EBUSY)");
      }
      return realRmSync(p as fs.PathLike, opts as fs.RmOptions);
    }) as typeof fs.rmSync);

    await uninstallAll(getContext());

    expect(fs.existsSync(manifestPath()), "manifest preserved on sweep failure").toBe(true);
    expect(readManifest(), "manifest still readable").not.toBeNull();
  });
});
