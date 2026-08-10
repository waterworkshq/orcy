import fs from "node:fs";
import path from "node:path";
import type { InstallContext } from "./context.js";
import { backupFile } from "./writers/index.js";
import { record } from "./manifest.js";

const START_MARKER = "<!-- orcy:start -->";
const END_MARKER = "<!-- orcy:end -->";

function generateBlock(ctx: InstallContext): string {
  const lines = [
    "",
    START_MARKER,
    "",
    "## Orcy — AI Agent Task Orchestration",
    "",
    "This project provides task orchestration for AI coding agents.",
    "It includes a CLI tool, an MCP server, and an API + Web UI.",
    "",
    "### Available Tools",
    "",
    "| Tool | What it does | Installed |",
    "|------|-------------|-----------|",
  ];

  const cliExists = fs.existsSync(`${ctx.binDir}/orcy`);
  const apiExists = fs.existsSync(`${ctx.binDir}/orcy-api`);
  const mcpExists = fs.existsSync(`${ctx.binDir}/orcy-mcp`);

  lines.push(`| \`orcy\` CLI | Habitat management from terminal | ${cliExists ? "✓" : "✗"} |`);
  lines.push(`| \`orcy-api\` | REST API + Web UI | ${apiExists ? "✓" : "✗"} |`);
  lines.push(`| \`orcy-mcp\` | MCP server for AI agents | ${mcpExists ? "✓" : "✗"} |`);

  lines.push("", "### CLI Usage (if installed)");
  lines.push(
    "```",
    `orcy habitat list              # List habitats`,
    `orcy habitat summary <id>      # Habitat activity summary`,
    `orcy task claim <id>           # Claim a task`,
    `orcy task submit <id>          # Submit for review`,
    `orcy serve                     # Start API + UI`,
    "```",
  );

  if (mcpExists) {
    lines.push("", "### MCP Tools (available via skill tool)");
    lines.push("- **orcy_habitat** — habitat operations (list, find, summary, metrics, settings)");
    lines.push(
      "- **orcy_habitat_mission** — mission operations (list, create, delete, archive, get-context)",
    );
    lines.push("- **orcy_habitat_task** — task lifecycle (claim, submit, complete, release, etc.)");
    lines.push("- **orcy_habitat_agent** — agent management (register, list, heartbeat, stats)");
    lines.push("- **orcy_suggest** — get AI-ranked task suggestions");
    lines.push("- **orcy_admin** — webhooks, templates, batch operations");
    lines.push("- **orcy_pulse** — mission signal board (post findings, blockers, offers)");
  }

  if (cliExists || mcpExists) {
    lines.push("", `### Skill Files (if deployed)`);
    lines.push(`- \`~/.claude/skills/orcy-overview/\` — Habitat model overview`);
    lines.push(`- \`~/.claude/skills/orcy-cli-usage/\` — CLI command reference`);
    lines.push(`- \`~/.claude/skills/orcy-mcp-usage/\` — MCP tool reference`);
    lines.push(`- \`~/.claude/skills/orcy-pulse/\` — Mission signal board reference`);
  }

  lines.push(
    "",
    `### Troubleshooting`,
    `Run \`orcy-install doctor\` to verify installation.`,
    "",
    END_MARKER,
  );
  return lines.join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a single orphan marker line (used when only one of START/END survives).
 * Removes the marker, any trailing text on its line, and the line's trailing
 * newline so no blank line is left behind.
 */
function stripMarkerLine(content: string, marker: string): string {
  const re = new RegExp(`[ \\t]*${escapeRegExp(marker)}[^\\n]*\\n?`, "g");
  return content.replace(re, "");
}

/**
 * Remove any orcy fence from `content` — whether complete (START..END) or
 * partial (only START or only END survives a user edit). Returns the cleaned
 * text; the caller decides whether to re-inject. Idempotent: a second pass is
 * a no-op (returns the input unchanged once no marker remains).
 *
 * T2.2: removes EVERY complete START..END pair (looping, so duplicate pairs
 * from a prior bug are all cleared — not just the first), then strips any
 * remaining lone markers. Guarantees inject×N converges to exactly one fence.
 */
function stripFence(content: string): string {
  let out = content;
  // Repeatedly drop the first complete START..END region until none remain.
  for (;;) {
    const s = out.indexOf(START_MARKER);
    const e = s === -1 ? -1 : out.indexOf(END_MARKER, s + START_MARKER.length);
    if (s === -1 || e === -1) break;
    out = out.substring(0, s) + out.substring(e + END_MARKER.length);
  }
  // Strip any leftover lone markers (orphan START or END with no partner, or
  // END-before-START). Line-stripped so no blank line is left behind.
  out = stripMarkerLine(out, START_MARKER);
  out = stripMarkerLine(out, END_MARKER);
  return out;
}

export function injectIntoFile(filePath: string, ctx: InstallContext): boolean {
  const block = generateBlock(ctx);
  const dir = path.dirname(filePath);

  let content = "";
  let bakPath: string | null = null;
  if (fs.existsSync(filePath)) {
    bakPath = backupFile(filePath);
    content = fs.readFileSync(filePath, "utf-8");
  }

  // Remove-then-inject (G8): strip any existing fence — complete or partial —
  // so re-injection (update / re-runs) never leaves a duplicate or orphan
  // marker, even if a user edit deleted only one of the markers.
  content = stripFence(content);

  // Inject a single fresh fence at the end.
  content = content.trimEnd() + "\n" + block + "\n";

  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  record({ path: filePath, action: "fenced", marker: START_MARKER, backup: bakPath ?? undefined });
  return true;
}

export function removeFromFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const before = fs.readFileSync(filePath, "utf-8");
  const after = stripFence(before);
  if (after === before) return false;
  fs.writeFileSync(filePath, after, "utf-8");
  return true;
}
