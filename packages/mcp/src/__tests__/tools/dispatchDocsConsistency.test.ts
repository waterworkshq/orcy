import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
// orcy_admin is deliberately excluded: its descriptor/handler module exists
// (admin-dispatch.ts) but it is NOT registered in the served stdio server —
// absent from ALL_TOOLS (tools/index.ts) and TOOL_HANDLERS (mcp/src/index.ts)
// — so documenting its actions as callable MCP guidance would be drift. Batch
// task operations are served under orcy_habitat_task. This union is the
// SERVED surface only, not a claim of full catalog closure.
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

// ---------------------------------------------------------------------------
// Served-tool INVENTORY coverage. README's advertised tool count and both
// skill copies must catalog every tool registered in ALL_TOOLS with a
// substantive table row. This is an inventory claim only — a row proves the
// tool is taught, not that every action or runtime behavior is documented.
// ---------------------------------------------------------------------------

const README_MARKDOWN = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

const SKILL_COPIES = [
  "docs/SKILL.md",
  "packages/installer/skills/orcy-mcp-usage/SKILL.md",
] as const;

/**
 * The exact badge grammar README uses today:
 * `img.shields.io/badge/MCP--native-<N>%20tools-<color>`.
 * Returns the advertised count only when EXACTLY ONE recognized badge
 * exists — zero (badge removed) or several (grammar drifted) both fail.
 */
function readmeBadgeToolCount(readme: string): number | null {
  const badges = [...readme.matchAll(/img\.shields\.io\/badge\/MCP--native-(\d+)%20tools-[a-z]+/g)];
  return badges.length === 1 ? Number(badges[0]![1]) : null;
}

/**
 * Whether a skill copy carries a SUBSTANTIVE CATALOG TABLE ROW for
 * `toolName`: a row whose FIRST cell is exactly the backticked tool name and
 * whose action and description cells are both non-empty. A prose mention —
 * a backticked name inside an auth-boundary aside, or a call-form example
 * elsewhere — deliberately does NOT satisfy a missing row: mentions are not
 * teaching. Exact first-cell equality also keeps a longer name sharing a
 * prefix (`orcy_pulse_instructions`) from satisfying the shorter one
 * (`orcy_pulse`), so an unserved or renamed stub cannot sneak through.
 */
function hasSubstantiveCatalogRow(markdown: string, toolName: string): boolean {
  for (const line of markdown.split("\n")) {
    const cells = line.split("|");
    if (cells.length < 5) continue; // | name | actions | description | bookends
    if (cells[1]!.trim() !== `\`${toolName}\``) continue;
    if (cells[2]!.trim().length === 0) continue; // vacuous actions cell
    if (cells[3]!.trim().length === 0) continue; // vacuous description cell
    return true;
  }
  return false;
}

describe("served-tool inventory coverage (README badge + both skill copies)", () => {
  it("README advertises exactly one MCP-native tools badge whose count equals ALL_TOOLS.length", () => {
    const count = readmeBadgeToolCount(README_MARKDOWN);
    expect(
      count,
      "README must carry exactly one recognized MCP--native-<N>%20tools badge (zero or several = drift)",
    ).not.toBeNull();
    expect(count).toBe(ALL_TOOLS.length);
  });

  it.each([...SKILL_COPIES])(
    "%s catalogs every served tool (ALL_TOOLS) in a substantive table row",
    (file) => {
      const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
      const missing = ALL_TOOLS.map((t) => t.name).filter(
        (name) => !hasSubstantiveCatalogRow(markdown, name),
      );
      expect(
        missing,
        `${file} lacks a substantive catalog row (first cell = exact backticked tool name, non-empty action + description cells) for served tools: ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );

  it("checker discriminates: a removed row stays uncovered even when exact-name prose survives; prefix names and vacuous rows never pass", () => {
    // Real-file negative: strip the orcy_review/orcy_sprint rows from the
    // actual installer skill while its auth-boundary prose keeps naming both
    // tools backticked — both must come back uncovered.
    const installer = readFileSync(
      path.join(REPO_ROOT, "packages/installer/skills/orcy-mcp-usage/SKILL.md"),
      "utf8",
    );
    const rowStripped = installer
      .split("\n")
      .filter((line) => !line.startsWith("| `orcy_review`") && !line.startsWith("| `orcy_sprint`"))
      .join("\n");
    expect(rowStripped === installer).toBe(false); // the rows really were there to remove
    expect(installer).toContain("`orcy_review`"); // exact-name prose mention survives the strip
    expect(hasSubstantiveCatalogRow(rowStripped, "orcy_review")).toBe(false);
    expect(hasSubstantiveCatalogRow(rowStripped, "orcy_sprint")).toBe(false);

    // Synthetic: exact backticked prose without any row does not count.
    const proseOnly = "Reviewer MANAGEMENT (`orcy_review` add/remove) is human-only.";
    expect(hasSubstantiveCatalogRow(proseOnly, "orcy_review")).toBe(false);

    // Prefix non-bleed: a longer tool's row never satisfies the shorter name.
    const prefixRow = "| `orcy_pulse_instructions` | (tool) | Pulse guide |";
    expect(hasSubstantiveCatalogRow(prefixRow, "orcy_pulse")).toBe(false);
    expect(hasSubstantiveCatalogRow(prefixRow, "orcy_pulse_instructions")).toBe(true);

    // A vacuous row (empty action/description cells) is not substantive.
    expect(hasSubstantiveCatalogRow("| `orcy_suggest` |   |   |", "orcy_suggest")).toBe(false);

    expect(
      readmeBadgeToolCount("no badge here"),
      "badge removed → null, not a silent pass",
    ).toBeNull();
    const tampered = README_MARKDOWN.replace(
      /MCP--native-(\d+)%20tools/,
      `MCP--native-${ALL_TOOLS.length + 1}%20tools`,
    );
    expect(readmeBadgeToolCount(tampered)).toBe(ALL_TOOLS.length + 1); // wrong count is read out, so the equality assert above fails on it
  });
});
