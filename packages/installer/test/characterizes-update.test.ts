import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import {
  readManifest,
  countEntries,
  createAgentConfigDir,
  defaultSkillRoot,
  tempHome,
} from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { getContext } from "../src/context.js";
import { updateInstall } from "../src/lifecycle.js";

describe("update", () => {
  it("should replay MCP config writes and skill installation on update", async () => {
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
    expect(mergedBefore, "precondition: MCP config written during install").toBeGreaterThanOrEqual(1);
    expect(copiedBefore, "precondition: skills copied during install").toBeGreaterThanOrEqual(1);

    // Delete MCP config + a skill dir so we can prove update replays them.
    const mcpConfigPath = path.join(tempHome(), ".claude", "settings.json");
    expect(fs.existsSync(mcpConfigPath), "precondition: MCP config exists after install").toBe(true);
    fs.unlinkSync(mcpConfigPath);

    const skillDir = path.join(defaultSkillRoot(), "orcy-overview");
    expect(fs.existsSync(skillDir), "precondition: skill dir exists after install").toBe(true);
    fs.rmSync(skillDir, { recursive: true });

    const ctx = getContext();
    await updateInstall(ctx);

    // Update replayed MCP config — file re-created with orcy server block.
    expect(fs.existsSync(mcpConfigPath), "MCP config re-created by update replay").toBe(true);
    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
    expect(mcpConfig.mcpServers?.orcy).toBeDefined();

    // Update replayed skills — dir re-created.
    expect(fs.existsSync(skillDir), "skill dir re-created by update replay").toBe(true);

    // Manifest dedup (P1.1 {path, action}) prevents duplicate entries — counts unchanged.
    expect(countEntries((e) => e.action === "merged-json")).toBe(mergedBefore);
    expect(countEntries((e) => e.action === "copied")).toBe(copiedBefore);
    expect(readManifest()).not.toBeNull();
  });
});
