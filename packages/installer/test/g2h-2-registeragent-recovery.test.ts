/**
 * G2H.2 — registerAgent recovery-aware viability (cold-review Tier 1, T1.1).
 *
 * Locks in: isJournalViable returns FALSE when a registerAgent step reached the
 * remote POST (phase "credentials") but did not finish (status != done) — the
 * orphan-risk state that must block auto-resume. And orphanedAgentIds extracts
 * those agentIds so recovery can surface them.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { isJournalViable, orphanedAgentIds } from "../src/lifecycle.js";
import type { Journal } from "../src/journal.js";

function journal(
  steps: Array<
    Partial<Journal["steps"][number]> & {
      path: string;
      action: string;
      step: number;
      status: string;
      ts: string;
    }
  >,
): Journal {
  return {
    version: 1,
    startedAt: "2024-01-01T00:00:00Z",
    components: [],
    steps: steps as Journal["steps"],
  };
}

describe("G2H.2 — isJournalViable blocks on an unresolved registration", () => {
  it("returns false when a registerAgent step is at phase 'credentials', pending (POST done, local write not)", () => {
    const j = journal([
      { path: "/x/bin/orcy", action: "created", step: 0, status: "done", ts: "t" },
      {
        path: "/x/credentials.json",
        action: "created",
        step: 1,
        status: "pending",
        ts: "t",
        phase: "credentials",
        phasePayload: { agentId: "agent-A" },
      },
    ]);
    expect(isJournalViable(j)).toBe(false);
  });

  it("returns false when the registration step is failed (G2H.2 marks failed, not pending)", () => {
    const j = journal([
      {
        path: "/x/credentials.json",
        action: "created",
        step: 0,
        status: "failed",
        ts: "t",
        phase: "credentials",
        phasePayload: { agentId: "agent-B" },
        error: "disk full",
      },
    ]);
    expect(isJournalViable(j)).toBe(false);
  });

  it("returns true when the registration step is fully done and its artifact is present (no orphan)", () => {
    // A done credentials-phase step is NOT an orphan — the orphan check is
    // `status !== 'done'`, so a done registration passes it. Viability then
    // reduces to the ordinary disk-presence check.
    const credPath = path.join(orcyHome(), "credentials.json");
    fs.writeFileSync(credPath, "{}", { mode: 0o600 });
    const j = journal([
      {
        path: credPath,
        action: "created",
        step: 0,
        status: "done",
        ts: "t",
        phase: "credentials",
        phasePayload: { agentId: "agent-C" },
      },
    ]);
    expect(isJournalViable(j)).toBe(true);
  });
});

describe("G2H.2 — orphanedAgentIds", () => {
  it("collects agentIds from non-done credentials-phase steps", () => {
    const j = journal([
      { path: "/a", action: "created", step: 0, status: "done", ts: "t" },
      {
        path: "/c1",
        action: "created",
        step: 1,
        status: "pending",
        ts: "t",
        phase: "credentials",
        phasePayload: { agentId: "agent-1" },
      },
      {
        path: "/c2",
        action: "created",
        step: 2,
        status: "failed",
        ts: "t",
        phase: "credentials",
        phasePayload: { agentId: "agent-2" },
      },
      {
        path: "/c3",
        action: "created",
        step: 3,
        status: "done",
        ts: "t",
        phase: "credentials",
        phasePayload: { agentId: "agent-3" },
      },
    ]);
    // agent-3 is done (no orphan); agent-1 pending + agent-2 failed are orphans.
    expect(orphanedAgentIds(j).sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("returns empty when there are no unresolved registrations", () => {
    const j = journal([{ path: "/a", action: "created", step: 0, status: "done", ts: "t" }]);
    expect(orphanedAgentIds(j)).toEqual([]);
  });
});
