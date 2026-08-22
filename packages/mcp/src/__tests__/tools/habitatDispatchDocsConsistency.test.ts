import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HABITAT_ACTIONS } from "../../tools/habitat-dispatch.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

const DOC_FILES = ["docs/SKILL.md", "docs/INSTALL.md", "docs/ARCHITECTURE.md"] as const;

/**
 * Extracts the habitat-dispatch actions a doc file claims `orcy_habitat` supports:
 * the action cell of `orcy_habitat` table rows (backticked or plain comma lists)
 * plus `action: "..."` occurrences inside the doc section whose header announces
 * `orcy_habitat` (sub-sections inherit until the next tool header).
 */
function documentedActions(markdown: string): string[] {
  const actions = new Set<string>();
  for (const row of markdown.matchAll(/^\|\s*`orcy_habitat`\s*\|([^|\n]*)\|/gm)) {
    for (const token of row[1].matchAll(/[a-z][a-z-]*/g)) actions.add(token[0]);
  }
  // Harvest `action: "..."` only inside the doc section whose header announces
  // `orcy_habitat` (sub-section headers without a tool token inherit it; a
  // sibling tool header like `orcy_habitat_task` switches context away).
  let currentTool: string | null = null;
  for (const line of markdown.split("\n")) {
    const headerTools = [...line.matchAll(/orcy_[a-z_]+/g)];
    if (/^#{1,4}\s/.test(line) && headerTools.length > 0) {
      currentTool = headerTools[headerTools.length - 1][0];
      continue;
    }
    if (currentTool !== "orcy_habitat") continue;
    for (const call of line.matchAll(/action:\s*"([a-z-]+)"/g)) actions.add(call[1]);
    for (const call of line.matchAll(/"action":\s*"([a-z-]+)"/g)) actions.add(call[1]);
  }
  return [...actions];
}

describe("docs document only live habitat-dispatch actions", () => {
  it.each([...DOC_FILES])("%s", (file) => {
    const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const documented = documentedActions(markdown);
    expect(documented.length, "expected to find documented orcy_habitat actions").toBeGreaterThan(
      0,
    );

    const live = Object.keys(HABITAT_ACTIONS);
    const removed = documented.filter((action) => !live.includes(action));
    expect(
      removed,
      `${file} documents habitat-dispatch actions that no longer exist: ${removed.join(", ")}`,
    ).toEqual([]);
  });
});
