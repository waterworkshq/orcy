import fs from 'node:fs';
import path from 'node:path';
import type { InstallContext } from './context.js';
import { backupFile } from './writers/index.js';
import { record } from './manifest.js';

const START_MARKER = '<!-- orcy:start -->';
const END_MARKER = '<!-- orcy:end -->';

function generateBlock(ctx: InstallContext): string {
  const lines = [
    '',
    START_MARKER,
    '',
    '## Orcy — AI Agent Task Orchestration',
    '',
    'This project provides task orchestration for AI coding agents.',
    'It includes a CLI tool, an MCP server, and an API + Web UI.',
    '',
    '### Available Tools',
    '',
    '| Tool | What it does | Installed |',
    '|------|-------------|-----------|',
  ];

  const cliExists = fs.existsSync(`${ctx.binDir}/orcy`);
  const apiExists = fs.existsSync(`${ctx.binDir}/orcy-api`);
  const mcpExists = fs.existsSync(`${ctx.binDir}/orcy-mcp`);

  lines.push(`| \`orcy\` CLI | Habitat management from terminal | ${cliExists ? '✓' : '✗'} |`);
  lines.push(`| \`orcy-api\` | REST API + Web UI | ${apiExists ? '✓' : '✗'} |`);
  lines.push(`| \`orcy-mcp\` | MCP server for AI agents | ${mcpExists ? '✓' : '✗'} |`);

  lines.push('', '### CLI Usage (if installed)');
  lines.push('```', `orcy habitat list              # List habitats`, `orcy habitat summary <id>      # Habitat activity summary`, `orcy task claim <id>           # Claim a task`, `orcy task submit <id>          # Submit for review`, `orcy serve                     # Start API + UI`, '```');

  if (mcpExists) {
    lines.push('', '### MCP Tools (available via skill tool)');
    lines.push('- **orcy_habitat** — habitat operations (list, find, summary, metrics, settings)');
    lines.push('- **orcy_habitat_mission** — mission operations (list, create, delete, archive, get-context)');
    lines.push('- **orcy_habitat_task** — task lifecycle (claim, submit, complete, release, etc.)');
    lines.push('- **orcy_habitat_agent** — agent management (register, list, heartbeat, stats)');
    lines.push('- **orcy_suggest** — get AI-ranked task suggestions');
    lines.push('- **orcy_admin** — webhooks, templates, batch operations');
    lines.push('- **orcy_pulse** — mission signal board (post findings, blockers, offers)');
  }

  if (cliExists || mcpExists) {
    lines.push('', `### Skill Files (if deployed)`);
    lines.push(`- \`~/.claude/skills/orcy-overview/\` — Habitat model overview`);
    lines.push(`- \`~/.claude/skills/orcy-cli-usage/\` — CLI command reference`);
    lines.push(`- \`~/.claude/skills/orcy-mcp-usage/\` — MCP tool reference`);
    lines.push(`- \`~/.claude/skills/orcy-pulse/\` — Mission signal board reference`);
  }

  lines.push('', `### Troubleshooting`, `Run \`orcy-install doctor\` to verify installation.`, '', END_MARKER);
  return lines.join('\n');
}

export function injectIntoFile(filePath: string, ctx: InstallContext): boolean {
  const block = generateBlock(ctx);
  const dir = path.dirname(filePath);

  let content = '';
  let bakPath: string | null = null;
  if (fs.existsSync(filePath)) {
    bakPath = backupFile(filePath);
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    content = content.substring(0, startIdx) + block + content.substring(endIdx + END_MARKER.length);
  } else {
    content = content.trimEnd() + '\n' + block + '\n';
  }

  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  record({ path: filePath, action: 'fenced', marker: START_MARKER, backup: bakPath ?? undefined });
  return true;
}

export function removeFromFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return false;
  content = content.substring(0, startIdx) + content.substring(endIdx + END_MARKER.length);
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}
