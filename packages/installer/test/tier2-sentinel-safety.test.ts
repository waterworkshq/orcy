/**
 * Cold-review Tier 2 (T2.7) — PATH sentinel viability/reversal safety.
 *
 * isJournalViable must reject an `appended` step whose sentinels are start-only
 * or misordered (END before START), and reverseEntry's `appended` case must NOT
 * splice a misordered pair (which would corrupt the rc file).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { isJournalViable, rollbackJournal } from "../src/lifecycle.js";
import { SENTINEL_START, SENTINEL_END } from "../src/path-shim.js";
import type { Journal } from "../src/journal.js";

function journal(steps: Array<Record<string, unknown>>): Journal {
  return {
    version: 1,
    startedAt: "2024-01-01T00:00:00Z",
    components: [],
    steps: steps as unknown as Journal["steps"],
  };
}

describe("T2.7 — appended sentinel viability rejects incomplete/misordered pairs", () => {
  it("start-only (no END) → not viable", () => {
    const rc = path.join(orcyHome(), ".bashrc");
    fs.writeFileSync(rc, `# head\n${SENTINEL_START}\nexport PATH=...\n`, "utf-8");
    const j = journal([{ path: rc, action: "appended", step: 0, status: "done", ts: "t" }]);
    expect(isJournalViable(j)).toBe(false);
  });

  it("END before START (misordered) → not viable", () => {
    const rc = path.join(orcyHome(), ".bashrc");
    fs.writeFileSync(rc, `${SENTINEL_END}\nmid\n${SENTINEL_START}\n`, "utf-8");
    const j = journal([{ path: rc, action: "appended", step: 0, status: "done", ts: "t" }]);
    expect(isJournalViable(j)).toBe(false);
  });

  it("properly ordered START..END → viable", () => {
    const rc = path.join(orcyHome(), ".bashrc");
    fs.writeFileSync(rc, `${SENTINEL_START}\nexport PATH=...\n${SENTINEL_END}\n`, "utf-8");
    const j = journal([{ path: rc, action: "appended", step: 0, status: "done", ts: "t" }]);
    expect(isJournalViable(j)).toBe(true);
  });
});

describe("T2.7 — reversal leaves a misordered appended pair untouched (no corruption)", () => {
  it("does not splice when END precedes START", () => {
    const rc = path.join(orcyHome(), ".bashrc");
    const original = `head\n${SENTINEL_END}\nMIDDLE\n${SENTINEL_START}\ntail\n`;
    fs.writeFileSync(rc, original, "utf-8");

    rollbackJournal(
      getContext(),
      journal([{ path: rc, action: "appended", step: 0, status: "done", ts: "t" }]),
    );

    // File unchanged — not corruptly spliced.
    expect(fs.readFileSync(rc, "utf-8")).toBe(original);
  });
});
