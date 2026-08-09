import { describe, it, expect } from "vitest";
import "./helpers/setup.js";
import {
  readManifest,
  countEntries,
  createAgentConfigDir,
  defaultSkillRoot,
} from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { getContext } from "../src/context.js";
import { updateInstall } from "../src/lifecycle.js";

describe("update", () => {
  it("characterizes B2: update skips replay of MCP config and skills (flips to should_* in Phase 4)", async () => {
    // KNOWN-DESTRUCTIVE: pinned by characterizes_*; flips to should_* in Phase 4.
    // B2 = update does NOT replay MCP config writes or skill installation. Pinned via the
    // merged-json (MCP) and copied (skills) counts staying unchanged across update.
    // (The created/fenced "grows" assertions that previously relied on the no-dedup bug
    // were removed when record() gained {path, action} dedup in Phase 1 — update still
    // re-runs installPackages, but those records now dedupe and no longer grow the manifest.)
    createAgentConfigDir();
    await wizard({
      components: ["cli", "api", "mcp"],
      mcpClients: ["claude-code"],
      patchFiles: [],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    });

    const mergedBefore = countEntries((e) => e.action === "merged-json");
    const copiedBefore = countEntries((e) => e.action === "copied");
    expect(mergedBefore, "precondition: MCP config written during install").toBeGreaterThanOrEqual(
      1,
    );
    expect(copiedBefore, "precondition: skills copied during install").toBeGreaterThanOrEqual(1);

    const ctx = getContext();
    await updateInstall(ctx);

    // B2 pin: update does NOT replay MCP config writes — merged-json count unchanged.
    expect(countEntries((e) => e.action === "merged-json")).toBe(mergedBefore);
    // B2 pin: update does NOT replay skill installation — copied count unchanged.
    expect(countEntries((e) => e.action === "copied")).toBe(copiedBefore);
    // Sanity: readManifest still resolves (update did not corrupt the manifest).
    expect(readManifest()).not.toBeNull();
  });
});
