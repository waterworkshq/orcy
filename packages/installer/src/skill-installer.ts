import fs from "node:fs";
import path from "node:path";
import type { InstallContext } from "./context.js";
import { record, hashDir, findEntry } from "./manifest.js";

/**
 * Skill Deployment System
 *
 * Skills in `../skills/<name>/SKILL.md` are copied to ~/.claude/skills/ (and other
 * agent roots) during installation. Agents discover Orcy's capabilities through
 * these files at startup.
 *
 * To add a new skill:
 * 1. Create skills/<name>/SKILL.md with YAML frontmatter
 * 2. Add <name> to the return array in determineSkillsToInstall()
 * 3. If it's an MCP tool, update markdown-injector.ts and orcy-mcp-usage/SKILL.md
 *
 * See skills/README.md for full documentation.
 */

export function getInstallerDir(): string {
  return path.resolve(import.meta.dirname, "..");
}

export function determineSkillsToInstall(components: string[]): string[] {
  const hasCli = components.includes("cli");
  const hasMcp = components.includes("mcp");
  if (hasCli && hasMcp) return ["orcy-overview", "orcy-cli-usage", "orcy-mcp-usage", "orcy-pulse"];
  if (hasCli) return ["orcy-overview", "orcy-cli-usage"];
  if (hasMcp) return ["orcy-overview", "orcy-mcp-usage", "orcy-pulse"];
  return ["orcy-overview"];
}

export function installSkills(ctx: InstallContext, roots: string[], skillNames: string[]): void {
  const installerDir = getInstallerDir();
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    for (const skillName of skillNames) {
      const src = path.join(installerDir, "skills", skillName);
      const dest = path.join(root, skillName);
      if (!fs.existsSync(src)) {
        console.warn(`    Skill "${skillName}" not found in installer bundle, skipping`);
        continue;
      }
      // G6/G2H.1: if the skill dir was modified since install (recorded hash ≠
      // current), preserve the user's edits instead of overwriting. On a fresh
      // install there is no recorded entry → no guard → copies normally.
      if (fs.existsSync(dest)) {
        const recorded = findEntry(dest, "copied");
        if (recorded?.hash && hashDir(dest) !== recorded.hash) {
          console.warn(
            `    Skill "${skillName}" modified since install — preserved, not overwritten`,
          );
          continue;
        }
      }
      fs.cpSync(src, dest, { recursive: true });
      record({ path: dest, action: "copied", hash: hashDir(dest) });
      console.log(`    Installed skill: ${skillName} → ${root}`);
    }
  }
}
