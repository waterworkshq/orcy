import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TASK_DISPATCH_TOOL, TASK_DISPATCH_HANDLER } from "../../tools/task-dispatch.js";
import { ORCY_INSTRUCTIONS_TEXT } from "../../tools/instructions.js";

// Task-lifecycle example contract guard for the Batch A guidance surfaces:
// docs/SKILL.md, the installer orcy-mcp-usage skill, and the embedded MCP
// instructions guide. Unlike dispatchDocsConsistency (which checks that
// documented actions exist), this asserts the REQUIRED-FIELD shape of the
// documented `orcy_habitat_task` lifecycle examples against the served
// dispatch contract, with a live-handler discriminator proving the guard's
// expectations match the real required map. This is the served-surface
// example contract only — not a full catalog closure claim.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

const DOC_SURFACES: Array<[string, string]> = [
  ["docs/SKILL.md", readFileSync(path.join(REPO_ROOT, "docs/SKILL.md"), "utf8")],
  [
    "packages/installer/skills/orcy-mcp-usage/SKILL.md",
    readFileSync(path.join(REPO_ROOT, "packages/installer/skills/orcy-mcp-usage/SKILL.md"), "utf8"),
  ],
  ["packages/mcp/src/tools/instructions.ts (embedded guide)", ORCY_INSTRUCTIONS_TEXT],
];

/** Extracts every `orcy_habitat_task({...})` call — single-line and fenced multi-line blocks — with a terminated flag. */
function extractTaskCalls(
  text: string,
): Array<{ surface: string; block: string; closed: boolean }> {
  const calls: Array<{ surface: string; block: string; closed: boolean }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/orcy_habitat_task\(\{.*?\}\)/g)) {
      calls.push({ surface: line, block: m[0], closed: true });
    }
    if (/orcy_habitat_task\(\{\s*$/.test(line)) {
      const block: string[] = [line];
      let closed = false;
      for (let j = i + 1; j < lines.length && block.length <= 30; j++) {
        block.push(lines[j]);
        if (/\}\)/.test(lines[j])) {
          closed = true;
          break;
        }
      }
      calls.push({ surface: line, block: block.join("\n"), closed });
      i += block.length - 1;
    }
  }
  return calls;
}

/** Field expectations per lifecycle action, from the served task-dispatch contract. */
const PER_ACTION_FIELDS: Record<string, { require: RegExp[]; forbid: RegExp[] }> = {
  submit: { require: [/\bresult\b/, /executionToken/], forbid: [] },
  release: { require: [/\breason\b/, /executionToken/], forbid: [] },
  fail: { require: [/failureReason/, /executionToken/], forbid: [/(?<![a-zA-Z])reason\s*:/] },
  start: { require: [/executionToken/], forbid: [/\bstatus\s*:/] },
  reject: { require: [/\breason\b/], forbid: [/executionToken/] },
  approve: { require: [], forbid: [/executionToken/] },
  claim: { require: [], forbid: [/executionToken/] },
};

/** Actions whose calls must show a `taskId` (everything keyed by task; mission/board-keyed actions are exempt). */
const TASKID_EXEMPT = new Set(["list-in-mission", "create-in-mission"]);
const LIVE_ACTIONS =
  (TASK_DISPATCH_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    .action.enum ?? [];

/** Validates one surface's documented examples; returns human-readable violations (empty = clean). */
function docViolations(text: string): string[] {
  const violations: string[] = [];
  for (const { block, closed } of extractTaskCalls(text)) {
    const head = block.split("\n")[0].slice(0, 60);
    if (!closed) {
      violations.push(`unterminated call (no closing }) within 30 lines/EOF): ${head}`);
      continue;
    }
    const actionMatch = [...block.matchAll(/action:\s*"([a-z_-]+)"/g)];
    // Exactly one action per call block: a call swallowing the NEXT example
    // (the malformed-fence defect class) surfaces as two actions here.
    if (actionMatch.length !== 1) {
      violations.push(`ambiguous or unclosed call block (${actionMatch.length} actions): ${head}`);
      continue;
    }
    const action = actionMatch[0][1];
    if (!LIVE_ACTIONS.includes(action)) {
      violations.push(`documents dead action "${action}"`);
      continue;
    }
    if (!TASKID_EXEMPT.has(action) && !/\btaskId\b/.test(block)) {
      violations.push(`"${action}" example must present taskId: ${head}`);
    }
    const tokenedUpdate = /status:\s*"(in_progress|submitted|failed)"/.test(block);
    const tokenFreeUpdate = /status:\s*"(approved|done)"/.test(block);
    const rules =
      action === "update"
        ? {
            require: tokenedUpdate ? [/executionToken/] : [],
            forbid: tokenFreeUpdate ? [/executionToken/] : [],
          }
        : (PER_ACTION_FIELDS[action] ?? { require: [], forbid: [] });
    for (const re of rules.require) {
      if (!re.test(block)) violations.push(`"${action}" example must include ${re}: ${head}`);
    }
    for (const re of rules.forbid) {
      if (re.test(block)) violations.push(`"${action}" example must not include ${re}: ${head}`);
    }
  }
  return violations;
}

describe("task-lifecycle doc examples match the served action contract", () => {
  for (const [name, text] of DOC_SURFACES) {
    it(`${name}: every documented lifecycle call is terminated and carries its required wire fields`, () => {
      expect(
        extractTaskCalls(text).length,
        `${name} contains no orcy_habitat_task examples`,
      ).toBeGreaterThan(0);
      expect(docViolations(text), `${name} example-contract violations`).toEqual([]);
    });
  }

  it("negative fixture: an unclosed submit call MUST be reported", () => {
    const bad =
      '```\norcy_habitat_task({\n  action: "submit",\n  taskId: "t-1",\n  result: "r",\n  executionToken: "k",\n  artifacts: [{ type: "pr", url: "u" }]\n\nOutput: { "success": true }\n```';
    const v = docViolations(bad);
    expect(v.join("\n")).toContain("unterminated call");
  });

  it("negative fixture: a submit example missing taskId MUST be reported", () => {
    const bad = 'orcy_habitat_task({ action: "submit", result: "r", executionToken: "k" })';
    const v = docViolations(bad);
    expect(v.join("\n")).toContain("must present taskId");
  });
});

describe("guard expectations match the live dispatch required map", () => {
  /** Recording stub for the subset of KanbanApiClient the lifecycle handlers touch. */
  const stub = (log: unknown[][]) =>
    ({
      submitTask: async (...a: unknown[]) => {
        log.push(["submit", ...a]);
        return { success: true, task: { id: a[0] } };
      },
      failTask: async (...a: unknown[]) => {
        log.push(["fail", ...a]);
        return { task: { id: a[0] } };
      },
      rejectTask: async (...a: unknown[]) => {
        log.push(["reject", ...a]);
        return { task: { id: a[0] } };
      },
    }) as never;

  it("a well-formed documented submit reaches the client with its documented fields", async () => {
    const log: unknown[][] = [];
    const res = await TASK_DISPATCH_HANDLER(stub(log), {
      action: "submit",
      taskId: "t1",
      result: "r",
      executionToken: "k",
    });
    expect(res.isError).toBeUndefined();
    expect(log).toEqual([["submit", "t1", "r", undefined, "k"]]);
  });

  it("discriminator: the documented submit minus `result` is rejected by the live required map", async () => {
    const log: unknown[][] = [];
    const res = await TASK_DISPATCH_HANDLER(stub(log), {
      action: "submit",
      taskId: "t1",
      executionToken: "k",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("missing required parameters: result");
    expect(log).toEqual([]);
  });

  it("fail requires the documented failureReason field and maps it onto the wire reason", async () => {
    const log: unknown[][] = [];
    const res = await TASK_DISPATCH_HANDLER(stub(log), {
      action: "fail",
      taskId: "t1",
      failureReason: "external outage",
      executionToken: "k",
    });
    expect(res.isError).toBeUndefined();
    expect(log).toEqual([["fail", "t1", "external outage", "k"]]);

    const refused = await TASK_DISPATCH_HANDLER(stub([]), { action: "fail", taskId: "t1" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("missing required parameters: failureReason");
  });

  it("reject requires its documented reason field", async () => {
    const res = await TASK_DISPATCH_HANDLER(stub([]), { action: "reject", taskId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("missing required parameters: reason");
  });
});
