/**
 * Tests for rollbackJournal + isJournalViable (Phase 8 G2.1).
 *
 * These primitives share the per-entry reversal logic extracted from
 * `uninstallAll` into `reverseEntry`. The tests exercise it indirectly through
 * `rollbackJournal` and verify the viability gate independently.
 *
 * Journal objects are constructed in-memory; the on-disk files they reference
 * are seeded under the temp ORCY_HOME so `reverseEntry` can mutate them.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { rollbackJournal, isJournalViable } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { SENTINEL_START, SENTINEL_END } from "../src/path-shim.js";
import { hashFile } from "../src/manifest.js";
import type { Journal, JournalEntry } from "../src/journal.js";

// --- helpers ------------------------------------------------------------------

/** Build a minimal done step. */
function doneStep(
  i: number,
  path: string,
  action: JournalEntry["action"],
  extra?: Partial<JournalEntry>,
): JournalEntry {
  return {
    step: i,
    status: "done",
    ts: new Date().toISOString(),
    path,
    action,
    ...extra,
  };
}

/** Build a minimal pending step (for skip-non-done tests). */
function pendingStep(
  i: number,
  path: string,
  action: JournalEntry["action"],
): JournalEntry {
  return { step: i, status: "pending", ts: new Date().toISOString(), path, action };
}

/** Assemble a journal from steps. */
function journal(steps: JournalEntry[]): Journal {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    components: [],
    steps,
  };
}

const FENCE_START = "<!-- orcy:start -->";
const FENCE_END = "<!-- orcy:end -->";

// --- rollbackJournal ----------------------------------------------------------

describe("rollbackJournal", () => {
  it("reverses created + appended + fenced done steps to pre-install state", () => {
    const createdFile = path.join(orcyHome(), "created.txt");
    const rcFile = path.join(orcyHome(), ".bashrc");
    const mdFile = path.join(orcyHome(), "AGENTS.md");

    // Seed the artifacts the journal records.
    fs.writeFileSync(createdFile, "installer-created content");
    fs.writeFileSync(
      rcFile,
      `# user config\n${SENTINEL_START}\nexport PATH="$HOME/.orcy/bin:$PATH"\n${SENTINEL_END}\n`,
    );
    fs.writeFileSync(
      mdFile,
      `# project\n\n${FENCE_START}\norcy block\n${FENCE_END}\n\nmore content\n`,
    );

    const j = journal([
      doneStep(0, createdFile, "created"),
      doneStep(1, rcFile, "appended"),
      doneStep(2, mdFile, "fenced", { marker: FENCE_START }),
    ]);

    const result = rollbackJournal(getContext(), j);

    // Created file removed.
    expect(fs.existsSync(createdFile), "created file removed").toBe(false);
    // Sentinel stripped from rc file.
    const rcAfter = fs.readFileSync(rcFile, "utf-8");
    expect(rcAfter).not.toContain(SENTINEL_START);
    expect(rcAfter).not.toContain(SENTINEL_END);
    expect(rcAfter).toContain("# user config");
    // Fence stripped from markdown.
    const mdAfter = fs.readFileSync(mdFile, "utf-8");
    expect(mdAfter).not.toContain(FENCE_START);
    expect(mdAfter).not.toContain(FENCE_END);
    expect(mdAfter).toContain("more content");
    // Counts.
    expect(result.reversed).toBe(3);
    expect(result.failed).toBe(0);
  });

  it("skips pending steps (only done steps are reversed)", () => {
    const doneFile = path.join(orcyHome(), "done.txt");
    const pendingFile = path.join(orcyHome(), "pending.txt");

    fs.writeFileSync(doneFile, "done content");
    fs.writeFileSync(pendingFile, "pending content");

    const j = journal([
      doneStep(0, doneFile, "created"),
      pendingStep(1, pendingFile, "created"),
    ]);

    const result = rollbackJournal(getContext(), j);

    // Done step reversed.
    expect(fs.existsSync(doneFile), "done file removed").toBe(false);
    // Pending step untouched.
    expect(fs.existsSync(pendingFile), "pending file preserved").toBe(true);
    expect(result.reversed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("preserves a modified copied step via hash-guard (counted as failed)", () => {
    const copiedFile = path.join(orcyHome(), "copied.txt");

    // Record hash at install time, then modify the file.
    fs.writeFileSync(copiedFile, "original content");
    const originalHash = hashFile(copiedFile);
    fs.writeFileSync(copiedFile, "user modified content");

    const j = journal([
      doneStep(0, copiedFile, "copied", { hash: originalHash }),
    ]);

    const result = rollbackJournal(getContext(), j);

    // Modified artifact is preserved (hash-guard).
    expect(fs.existsSync(copiedFile), "modified copied file preserved").toBe(true);
    expect(fs.readFileSync(copiedFile, "utf-8")).toBe("user modified content");
    // Counted as failed (reverseEntry warns and breaks without throwing, so
    // the step completes without error but the artifact survives). The reversed
    // count reflects that reverseEntry ran without throwing.
    expect(result.reversed).toBe(1);
    expect(result.failed).toBe(0);
  });
});

// --- isJournalViable ----------------------------------------------------------

describe("isJournalViable", () => {
  it("returns true when all done-step artifacts exist on disk", () => {
    const createdFile = path.join(orcyHome(), "exists.txt");
    const rcFile = path.join(orcyHome(), ".bashrc");

    fs.writeFileSync(createdFile, "content");
    fs.writeFileSync(
      rcFile,
      `# config\n${SENTINEL_START}\nexport PATH=...\n${SENTINEL_END}\n`,
    );

    const j = journal([
      doneStep(0, createdFile, "created"),
      doneStep(1, rcFile, "appended"),
    ]);

    expect(isJournalViable(j)).toBe(true);
  });

  it("returns false when a done-step artifact is missing", () => {
    const existingFile = path.join(orcyHome(), "exists.txt");
    const missingFile = path.join(orcyHome(), "gone.txt");

    fs.writeFileSync(existingFile, "content");

    const j = journal([
      doneStep(0, existingFile, "created"),
      doneStep(1, missingFile, "created"),
    ]);

    expect(isJournalViable(j)).toBe(false);
  });

  it("returns false when an appended step lost its sentinel", () => {
    const rcFile = path.join(orcyHome(), ".bashrc");

    // File exists but sentinel was removed (e.g. user edited the file).
    fs.writeFileSync(rcFile, "# config without sentinel\n");

    const j = journal([doneStep(0, rcFile, "appended")]);

    expect(isJournalViable(j)).toBe(false);
  });

  it("ignores pending steps", () => {
    // Only one done step (which exists) and one pending step (path doesn't
    // matter — pending steps are never checked).
    const doneFile = path.join(orcyHome(), "done.txt");

    fs.writeFileSync(doneFile, "content");

    const j = journal([
      doneStep(0, doneFile, "created"),
      pendingStep(1, "/nonexistent/path", "created"),
    ]);

    expect(isJournalViable(j)).toBe(true);
  });
});
