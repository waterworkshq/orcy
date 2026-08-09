import { describe, it, expect } from "vitest";
import "./helpers/setup.js";
import {
  readManifest,
  countEntries,
  createAgentConfigDir,
  createPatchFile,
  defaultSkillRoot,
} from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { getContext } from "../src/context.js";
import { updateInstall } from "../src/lifecycle.js";

describe("update", () => {
  it("characterizes B2: update re-runs installPackages + fenced re-inject, but skips MCP/skills/service/env replay", async () => {
    // KNOWN-DESTRUCTIVE: pinned by characterizes_*; flips to should_* in Phase 4.
    // B2 = update only re-runs installPackages (packages+shims) and re-injects fenced
    // markdown whose path includes AGENTS/CLAUDE; it does NOT replay MCP config
    // writes, skill installation, service install, or env refresh.
    createAgentConfigDir();
    const patchFile = createPatchFile("AGENTS.md");
    await wizard({
      components: ["cli", "api", "mcp"],
      mcpClients: ["claude-code"],
      patchFiles: [patchFile],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    });

    const ctx = getContext();
    const mergedBefore = countEntries((e) => e.action === "merged-json");
    const copiedBefore = countEntries((e) => e.action === "copied");
    const fencedBefore = countEntries(
      (e) => e.action === "fenced" && (e.path.includes("AGENTS") || e.path.includes("CLAUDE")),
    );
    const createdBefore = countEntries((e) => e.action === "created");
    expect(mergedBefore, "precondition: MCP config written during install").toBeGreaterThanOrEqual(
      1,
    );
    expect(copiedBefore, "precondition: skills copied during install").toBeGreaterThanOrEqual(1);
    expect(fencedBefore, "precondition: agent file injected during install").toBeGreaterThanOrEqual(
      1,
    );

    await updateInstall(ctx);

    // B2 pin: update does NOT replay MCP config writes.
    expect(countEntries((e) => e.action === "merged-json")).toBe(mergedBefore);
    // B2 pin: update does NOT replay skill installation.
    expect(countEntries((e) => e.action === "copied")).toBe(copiedBefore);
    // B2 pin: update DOES re-run installPackages → `created` entries grow (duplicates).
    expect(countEntries((e) => e.action === "created")).toBeGreaterThan(createdBefore);
    // B2 pin: update DOES re-inject fenced markdown for AGENTS/CLAUDE.
    expect(
      countEntries(
        (e) => e.action === "fenced" && (e.path.includes("AGENTS") || e.path.includes("CLAUDE")),
      ),
    ).toBeGreaterThan(fencedBefore);
  });
});
