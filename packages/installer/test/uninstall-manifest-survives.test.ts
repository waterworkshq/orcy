import { describe, it, expect, vi, afterEach } from "vitest";
import "./helpers/setup.js";
import fs from "node:fs";
import { wizard } from "../src/wizard.js";
import { uninstallAll } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { readManifest, manifestPath } from "./helpers/setup.js";

describe("P2.3 (B4): manifest survives partial uninstall failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should preserve the manifest when a removal entry throws", async () => {
    // 1. Seed a real installation.
    await wizard({
      components: ["cli", "api"],
      mcpClients: [],
      patchFiles: [],
      skillRoots: [],
      interactive: false,
    });

    const manifest = readManifest();
    expect(
      manifest,
      "precondition: manifest exists after install",
    ).not.toBeNull();

    // 2. Find a 'created' directory entry to fail on.
    const targetEntry = manifest!.files.find(
      (e) =>
        e.action === "created" &&
        fs.existsSync(e.path) &&
        fs.statSync(e.path).isDirectory(),
    );
    expect(
      targetEntry,
      "precondition: a created directory exists",
    ).toBeTruthy();
    const failPath = targetEntry!.path;

    // 3. Spy on fs.rmSync to throw for the target path only.
    const realRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, "rmSync").mockImplementation(((p: unknown, opts?: unknown) => {
      if (typeof p === "string" && p === failPath) {
        throw new Error("simulated removal failure");
      }
      return realRmSync(p as fs.PathLike, opts as fs.RmOptions);
    }) as typeof fs.rmSync);

    // 4. Uninstall — should warn and continue, NOT delete the manifest.
    await uninstallAll(getContext());

    // 5. Manifest survives so the user can retry.
    expect(
      fs.existsSync(manifestPath()),
      "manifest preserved on partial failure",
    ).toBe(true);
    expect(readManifest(), "manifest still readable").not.toBeNull();
  });
});
