import { describe, it, expect, vi } from "vitest";

// Track calls to service lifecycle functions so we can verify ordering.
const tracker = vi.hoisted(() => ({
  calls: [] as string[],
  fileToCheck: "",
}));

vi.mock("../src/service-installer.js", async () => {
  const nfs = await import("node:fs");
  return {
    stopService: () => {
      tracker.calls.push("stopService");
      // Record whether the manifest-referenced file still exists at stop time.
      if (tracker.fileToCheck) {
        tracker.calls.push(
          nfs.existsSync(tracker.fileToCheck)
            ? "file-exists-at-stop"
            : "file-gone-at-stop",
        );
      }
      return false;
    },
    uninstallService: () => {
      tracker.calls.push("uninstallService");
      return false;
    },
    installService: () => true,
  };
});

import "./helpers/setup.js";
import fs from "node:fs";
import { uninstallAll } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { wizard } from "../src/wizard.js";
import { readManifest } from "./helpers/setup.js";

describe("P2.1 (B1): uninstall stops service before file removal", () => {
  it("should call stopService and uninstallService before removing recorded files", async () => {
    // Seed a real installation via the wizard.
    await wizard({
      components: ["cli", "api"],
      mcpClients: [],
      patchFiles: [],
      skillRoots: [],
      interactive: false,
    });

    const manifest = readManifest();
    expect(manifest, "precondition: manifest exists").not.toBeNull();

    // Find a 'created' entry that still exists on disk.
    const createdEntry = manifest!.files.find(
      (e) => e.action === "created" && fs.existsSync(e.path),
    );
    expect(
      createdEntry,
      "precondition: a created entry exists on disk",
    ).toBeTruthy();
    tracker.fileToCheck = createdEntry!.path;

    tracker.calls = [];
    await uninstallAll(getContext());

    // stopService and uninstallService were both called.
    expect(tracker.calls).toContain("stopService");
    expect(tracker.calls).toContain("uninstallService");

    // The file still existed when stopService ran — proving stop-before-remove.
    expect(tracker.calls).toContain("file-exists-at-stop");

    // The file was eventually removed by the manifest-reversal loop.
    expect(fs.existsSync(createdEntry!.path)).toBe(false);
  });
});
