import { describe, it, expect } from "vitest";
import fs from "node:fs";
import "./helpers/setup.js";
import {
  orcyHome,
  readManifest,
  manifestPath,
  createPatchFile,
  defaultSkillRoot,
} from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { getContext } from "../src/context.js";
import { uninstallAll } from "../src/lifecycle.js";

describe("uninstall", () => {
  it("characterizes that uninstallAll removes recorded created paths and deletes the manifest (B1: file-removal only)", async () => {
    // KNOWN-DESTRUCTIVE: pinned by characterizes_*; flips to should_* in the phase
    // that fixes B1. B1 = the 'created' case removes files/dirs but does NOT stop a
    // running service. No service is alive in this test, so we pin only the
    // file-removal path.
    const patchFile = createPatchFile("AGENTS.md");
    await wizard({
      components: ["cli", "api", "mcp"],
      mcpClients: [],
      patchFiles: [patchFile],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    });

    const ctx = getContext();
    const before = readManifest();
    expect(before).not.toBeNull();

    // Pick a recorded `created` dir (an installed @orcy package) to verify removal.
    const createdEntry = before!.files.find(
      (e) => e.action === "created" && /node_modules\/@orcy\//.test(e.path),
    );
    expect(createdEntry, "precondition: a created @orcy node_modules dir exists").toBeTruthy();
    const targetPath = createdEntry!.path;
    expect(fs.existsSync(targetPath)).toBe(true);

    await uninstallAll(ctx);

    // B1 pin: the recorded dir is removed (file-removal path runs).
    expect(fs.existsSync(targetPath), "recorded created dir removed on uninstall").toBe(false);
    // The manifest itself is deleted at the end of uninstall.
    expect(fs.existsSync(manifestPath()), "manifest deleted at end of uninstall").toBe(false);
    // ORCY_HOME itself is preserved (db/env kept); only manifest + managed files go.
    expect(fs.existsSync(orcyHome()), "orcyHome dir preserved").toBe(true);
  });
});
