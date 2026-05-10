# @orcy/installer — Skill Deployment System

This package handles deployment of Orcy skill files to AI agent skill directories.
Skills are how agents (Claude Code, OpenCode) discover Orcy's capabilities at startup.

## How Skills Work

Each skill is a directory under `skills/` containing a `SKILL.md` file with YAML frontmatter.
The installer copies these to agent skill roots (e.g., `~/.claude/skills/`) during installation.

## Adding a New Skill

To add a new skill that gets deployed with Orcy:

1. **Create the skill file:** `skills/<skill-name>/SKILL.md`
   - Must have YAML frontmatter with `name` and `description`
   - `name` must match the directory name (kebab-case, no underscores/capitals)
   - `description` should follow the formula: `"{action verb} {objects}. Use when {trigger scenarios}."`
   - Keep the body concise — it's loaded at agent startup
   - The `files` field in `packages/installer/package.json` includes `"skills"` — new skill dirs are auto-included

2. **Register it in `skill-installer.ts`:**
   - Add the skill name to the return array in `determineSkillsToInstall()`
   - If it should only install with specific components (cli/mcp), add it conditionally
   - If this replaces an old skill, update `uninstallSkills()` to handle the old name

3. **Update `markdown-injector.ts` in TWO places:**
   - **MCP tools list** (line ~39-45): Add the tool entry if it's an MCP tool
   - **Skill files list** (line ~49-52): Add the skill directory entry

4. **Update `lifecycle.ts` ONLY if this replaces an old skill:**
   - The `newSkills` and `oldSkills` arrays are parallel for migration renames
   - Only add entries here if the skill replaces an old `kanban-*` named skill
   - If the new skill has no predecessor, do NOT add it here

5. **Update `orcy-mcp-usage/SKILL.md` if it's an MCP tool:**
   - Add to the consolidated dispatch tools table
   - Add to the startup sequence if it changes agent workflow
   - Add to the best practices if it changes agent behavior

6. **Update `orcy-cli-usage/SKILL.md` if it has CLI commands:**
   - Add the command section with examples

7. **Test the deployment:**
   - `pnpm --filter @orcy/installer build` to verify the package builds
   - After installation, verify the skill directory exists under `~/.claude/skills/<skill-name>/`
   - The agent's next startup should auto-discover the new skill

## Existing Skills

| Skill Directory | Component | Purpose |
|----------------|-----------|---------|
| `orcy-overview/` | core | Hierarchical model, authentication, CLI vs MCP decision |
| `orcy-cli-usage/` | cli | CLI command reference |
| `orcy-mcp-usage/` | mcp | MCP tool reference (all tools, startup sequence, lifecycle, examples) |
| `orcy-pulse/` | mcp | Mission signal board protocol |

## Verification

After adding a skill, verify:
- `pnpm --filter @orcy/installer typecheck` passes
- The skill directory exists under `skills/`
- `determineSkillsToInstall()` returns the new skill for the correct components
- The new skill name is NOT in `lifecycle.ts` `newSkills` unless it's a migration rename
