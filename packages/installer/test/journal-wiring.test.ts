/**
 * Tests for the journal wiring in the install flow (P1.4). Verifies:
 * (a) Fresh install: journal is created mid-flight, committed to a manifest,
 *     and deleted after wizard() returns.
 * (b) Stale journal + interactive "clear": journal discarded, install proceeds,
 *     fresh manifest committed.
 * (c) Stale journal + non-interactive: wizard throws with a structured error.
 *
 * Uses the same harness as characterization tests (temp ORCY_HOME, mocked
 * execSync/fetch/prompts). The real node:fs operates on the temp dir.
 */
import { describe, it, expect } from "vitest";
import "./helpers/setup.js";
import {
  readManifest,
  createAgentConfigDir,
  createPatchFile,
  defaultSkillRoot,
} from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import {
  journalExists,
  createJournal,
  appendStep,
  markStepDone,
  readJournal,
} from "../src/journal.js";

describe("journal wiring in the install flow", () => {
  it("(a) fresh install: journal committed to manifest and deleted after wizard returns", async () => {
    createAgentConfigDir();
    const patchFile = createPatchFile("AGENTS.md");

    await wizard({
      components: ["cli", "api", "mcp"],
      mcpClients: ["claude-code"],
      patchFiles: [patchFile],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    });

    // Journal was committed and deleted.
    expect(journalExists(), "journal deleted after successful install").toBe(false);

    // Manifest committed with expected components and files.
    const m = readManifest();
    expect(m).not.toBeNull();
    expect(m!.components).toEqual(expect.arrayContaining(["cli", "api", "mcp"]));
    expect(m!.files.length).toBeGreaterThan(0);

    // Implicit proof the journal was in flight during the install body: if
    // record()/addComponent() had NOT redirected to the journal, commitJournal()
    // would have overwritten the manifest with the empty journal's data —
    // components and files would be empty.
  });

  it("(b) stale journal + interactive clear → journal discarded, install proceeds, fresh manifest committed", async () => {
    // Pre-seed a stale journal from a previous interrupted install.
    createJournal({ components: ["cli"] });
    appendStep({ path: "/tmp/stale-step", action: "created" });
    markStepDone(0);
    expect(journalExists(), "precondition: stale journal exists").toBe(true);

    createAgentConfigDir();
    const patchFile = createPatchFile("AGENTS.md");

    // interactive: true triggers the stale-journal confirm prompt. The harness
    // mock for confirm() returns true (clear), then true again for proceed.
    await wizard({
      components: ["cli", "api", "mcp"],
      mcpClients: ["claude-code"],
      patchFiles: [patchFile],
      skillRoots: [defaultSkillRoot()],
      interactive: true,
    });

    // Stale journal was discarded, new install completed cleanly.
    expect(journalExists(), "journal deleted after clear + fresh install").toBe(false);

    const m = readManifest();
    expect(m).not.toBeNull();
    expect(m!.components).toEqual(expect.arrayContaining(["cli", "api", "mcp"]));
    expect(m!.files.length).toBeGreaterThan(0);
  });

  it("(c) stale journal + non-interactive → wizard throws (CI fail)", async () => {
    // Pre-seed a stale journal.
    createJournal({ components: ["cli"] });
    appendStep({ path: "/tmp/stale-step", action: "created" });
    markStepDone(0);
    expect(journalExists(), "precondition: stale journal exists").toBe(true);

    // Non-interactive: must throw, not auto-resume or auto-rollback.
    await expect(
      wizard({
        components: ["cli", "api", "mcp"],
        mcpClients: [],
        patchFiles: [],
        skillRoots: [],
        interactive: false,
      }),
    ).rejects.toThrow(/stale installation journal/);

    // Journal is NOT discarded — still on disk for manual inspection / recovery.
    expect(journalExists(), "journal preserved for manual recovery").toBe(true);
  });
});

describe("registerAgent reconciliation via journal-aware record()", () => {
  it("writeCredentials' record() no-ops against the P1.3 appendStep (dedup on {path, action})", async () => {
    // Simulate what registerAgent does: appendStep for credentials, then
    // writeCredentials internally calls record() for the same {path, action}.
    // The journal-aware record() must dedup against the existing step.
    createJournal();

    const { ORCY_PATHS } = await import("@orcy/shared");
    const realCredPath = ORCY_PATHS.credentialsFile;

    // P1.3: registerAgent appends the credentials step (pending, phase 'post')
    appendStep({ path: realCredPath, action: "created", phase: "post" });
    expect(readJournal()!.steps).toHaveLength(1);

    // writeCredentials calls record() — must be a no-op (step already exists)
    const { record } = await import("../src/manifest.js");
    record({ path: realCredPath, action: "created" });

    // Still only 1 step — record() was deduped, NOT appended as a second step.
    expect(readJournal()!.steps).toHaveLength(1);
    expect(readJournal()!.steps[0].path).toBe(realCredPath);
    expect(readJournal()!.steps[0].action).toBe("created");
  });
});
