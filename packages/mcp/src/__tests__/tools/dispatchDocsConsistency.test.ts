import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_ACTIONS } from "../../tools/admin-dispatch.js";
import { AGENT_ACTIONS } from "../../tools/agent-dispatch.js";
import { AUTOMATION_ACTIONS } from "../../tools/automation-dispatch.js";
import { HABITAT_ACTIONS } from "../../tools/habitat-dispatch.js";
import { HABITAT_SKILL_ACTIONS } from "../../tools/habitat-skill-dispatch.js";
import { LEARNING_ACTIONS } from "../../tools/learning-dispatch.js";
import { MESSAGE_ACTIONS } from "../../tools/message-dispatch.js";
import { MISSION_ACTIONS } from "../../tools/mission-dispatch.js";
import { NOTIFICATION_ACTIONS } from "../../tools/notification-dispatch.js";
import { PULSE_ACTIONS } from "../../tools/pulse-dispatch.js";
import { REVIEW_ACTIONS } from "../../tools/review-dispatch.js";
import { SPRINT_ACTIONS } from "../../tools/sprint-dispatch.js";
import { SUBSCRIPTION_ACTIONS } from "../../tools/subscription-dispatch.js";
import { SUGGEST_ACTIONS } from "../../tools/suggest-dispatch.js";
import { TASK_ACTIONS } from "../../tools/task-dispatch.js";
import { TRIAGE_ACTIONS } from "../../tools/triage-dispatch.js";
import { WIKI_ACTIONS } from "../../tools/wiki-dispatch.js";
import { WORKTREE_ACTIONS } from "../../tools/worktree-dispatch.js";
import { ORCY_INSTRUCTIONS_TEXT } from "../../tools/instructions.js";
import { ALL_TOOLS } from "../../tools/index.js";

// Docs-consistency guard over EVERY registry-driven dispatch tool and every
// doc surface that documents dispatch actions. Any documented action missing
// from its live registry (the drift class that caused the v0.40.2 docs fix)
// fails here. Extend by adding a row to DISPATCH_TOOLS or DOC_FILES.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

/** (toolName, live action keys) for every registry-driven dispatch tool. */
const DISPATCH_TOOLS = [
  ["orcy_habitat", Object.keys(HABITAT_ACTIONS)],
  ["orcy_habitat_mission", Object.keys(MISSION_ACTIONS)],
  ["orcy_habitat_task", Object.keys(TASK_ACTIONS)],
  ["orcy_habitat_agent", Object.keys(AGENT_ACTIONS)],
  ["orcy_admin", Object.keys(ADMIN_ACTIONS)],
  ["orcy_automation", Object.keys(AUTOMATION_ACTIONS)],
  ["orcy_habitat_skill", Object.keys(HABITAT_SKILL_ACTIONS)],
  ["orcy_learning", Object.keys(LEARNING_ACTIONS)],
  ["orcy_habitat_message", Object.keys(MESSAGE_ACTIONS)],
  ["orcy_notification", Object.keys(NOTIFICATION_ACTIONS)],
  ["orcy_pulse", Object.keys(PULSE_ACTIONS)],
  ["orcy_review", Object.keys(REVIEW_ACTIONS)],
  ["orcy_sprint", Object.keys(SPRINT_ACTIONS)],
  ["orcy_habitat_subscription", Object.keys(SUBSCRIPTION_ACTIONS)],
  ["orcy_suggest", Object.keys(SUGGEST_ACTIONS)],
  ["orcy_triage", Object.keys(TRIAGE_ACTIONS)],
  ["orcy_wiki", Object.keys(WIKI_ACTIONS)],
  ["orcy_worktree", Object.keys(WORKTREE_ACTIONS)],
] as const;

const DOC_FILES = [
  "docs/SKILL.md",
  "docs/INSTALL.md",
  "docs/ARCHITECTURE.md",
  "packages/installer/skills/orcy-mcp-usage/SKILL.md",
  "packages/installer/skills/orcy-pulse/SKILL.md",
] as const;

// Existence = advertised tools (ALL_TOOLS) ∪ registry-driven dispatch tools.
// orcy_admin is deliberately NOT advertised in ALL_TOOLS (batch actions live
// under orcy_habitat_task — pinned in tools.task.test.ts) but its handler is
// registered and its actions documented, so mentioning it is not drift.
const LIVE_TOOL_NAMES = new Set([
  ...ALL_TOOLS.map((t) => t.name),
  ...DISPATCH_TOOLS.map(([name]) => name),
]);
const TOOL_BY_NAME = new Map(DISPATCH_TOOLS);

/**
 * Extracts the actions a doc file claims `toolName` supports:
 * - the action cell of table rows whose FIRST cell is the tool (backticked or plain);
 * - explicit `tool({action: "..."})` calls anywhere, attributed to the tool on
 *   the same line (never to a section's announcing header, so cross-tool
 *   examples cannot misattribute);
 * - bare `action: "..."` / `"action": "..."` mentions inside a section whose
 *   header announces the tool (lines containing an explicit tool call are
 *   excluded — the call rule already owns them).
 */
function documentedActions(markdown: string, toolName: string): string[] {
  const actions = new Set<string>();
  const rowRe = new RegExp(`^\\|\\s*\`?${toolName}\`?\\s*\\|([^|\\n]*)`, "gm");
  for (const row of markdown.matchAll(rowRe)) {
    for (const token of row[1].matchAll(/[a-z][a-z_-]*/g)) actions.add(token[0]);
  }
  const callRe = new RegExp(`${toolName}\\(\\{\\s*action:\\s*"([a-z_-]+)"`, "g");
  for (const call of markdown.matchAll(callRe)) actions.add(call[1]);
  let currentTool: string | null = null;
  let openCallTool: string | null = null;
  for (const line of markdown.split("\n")) {
    const headerTools = [...line.matchAll(/orcy_[a-z_]+/g)];
    if (/^#{1,4}\s/.test(line) && headerTools.length > 0) {
      currentTool = headerTools[headerTools.length - 1][0];
      openCallTool = null;
      continue;
    }
    // Multi-line call blocks: `orcy_X({` opener with `action: "..."` on a
    // following line — attribute to X, never to the section's header tool.
    const opener = [...line.matchAll(/(orcy_[a-z_]+)\(\{\s*$/g)];
    if (opener.length > 0) {
      openCallTool = opener[opener.length - 1][1];
      continue;
    }
    if (/\}\)/.test(line)) openCallTool = null;
    if (openCallTool === toolName) {
      for (const call of line.matchAll(/action:\s*"([a-z_-]+)"/g)) actions.add(call[1]);
      continue;
    }
    if (openCallTool !== null) continue; // inside another tool's multi-line call block
    if (currentTool !== toolName) continue;
    if (/orcy_[a-z_]+\(\{/.test(line)) continue;
    // Skip task-event payload examples: their "action" field values (created,
    // claimed, ...) are event actions, not dispatch actions.
    if (/"events"\s*:/.test(line)) continue;
    for (const call of line.matchAll(/action:\s*"([a-z_-]+)"/g)) actions.add(call[1]);
    for (const call of line.matchAll(/"action":\s*"([a-z_-]+)"/g)) actions.add(call[1]);
  }
  return [...actions];
}

describe("docs document only live dispatch-tool actions", () => {
  it.each([...DOC_FILES])("%s", (file) => {
    const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
    let documentedAnything = false;
    for (const [tool, live] of DISPATCH_TOOLS) {
      const documented = documentedActions(markdown, tool);
      if (documented.length === 0) continue;
      documentedAnything = true;
      const removed = documented.filter((action) => !live.includes(action));
      expect(
        removed,
        `${file} documents ${tool} actions that no longer exist: ${removed.join(", ")}`,
      ).toEqual([]);
    }
    expect(documentedAnything, `${file} documents no dispatch actions — the guard went blind`).toBe(
      true,
    );
  });
});

describe("embedded instructions guide documents only live tools and actions", () => {
  const text = ORCY_INSTRUCTIONS_TEXT;

  it("every orcy_* tool name mentioned is a registered tool", () => {
    const mentioned = [...new Set([...text.matchAll(/orcy_[a-z_]+/g)].map((m) => m[0]))];
    expect(mentioned.length).toBeGreaterThan(0);
    const dead = mentioned.filter((name) => !LIVE_TOOL_NAMES.has(name));
    expect(
      dead,
      `instructions.ts mentions tools that are not registered: ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("every TOOL({action: ...}) call targets a live action of that tool", () => {
    const calls = [...text.matchAll(/(orcy_[a-z_]+)\(\{ ?action:\s*"([a-z_-]+)"/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, tool, action] of calls) {
      const live = TOOL_BY_NAME.get(tool);
      expect(live, `${tool} is not a registry-driven dispatch tool`).toBeDefined();
      expect(live, `${tool} has no live action "${action}"`).toContain(action);
    }
  });

  it("bullet-list action vocabularies list only live actions", () => {
    for (const line of text.split("\n")) {
      const m = /^- \*\*(orcy_[a-z_]+)\*\* — (.*)$/.exec(line);
      if (!m) continue;
      const live = TOOL_BY_NAME.get(m[1]);
      if (!live) continue;
      const tokens = [...m[2].matchAll(/\(([^()]*)\)/g)].flatMap((p) =>
        Array.from(p[1].matchAll(/[a-z][a-z_-]*/g), (t) => t[0]),
      );
      const removed = tokens.filter((t) => !live.includes(t));
      expect(
        removed,
        `${m[1]} bullet lists actions that no longer exist: ${removed.join(", ")}`,
      ).toEqual([]);
    }
  });
});
