/**
 * Unit tests for the in-flight installation journal (P1.2). Runs in isolation:
 * imports the test harness FIRST so `@orcy/shared`'s `ORCY_PATHS` is redirected
 * to a per-file temp dir, which makes `journalPath()` and the manifest path both
 * land in that temp dir. The real `node:fs` operates on the temp dir (no mocking
 * of fs); only external process invocations are stubbed by the harness.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import "./helpers/setup.js";
import { orcyHome, manifestPath, readManifest as readManifestHelper } from "./helpers/setup.js";
import {
  journalPath,
  journalExists,
  createJournal,
  readJournal,
  appendStep,
  setStepPhase,
  markStepDone,
  markStepFailed,
  addJournalComponent,
  commitJournal,
  discardJournal,
} from "../src/journal.js";

describe("journal lifecycle", () => {
  it("createJournal writes a valid journal and journalExists() is true", () => {
    expect(journalExists()).toBe(false);
    createJournal();
    expect(journalExists()).toBe(true);
    // file is valid JSON with the expected envelope
    const raw = JSON.parse(fs.readFileSync(journalPath(), "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.startedAt).toEqual(expect.any(String));
    expect(Array.isArray(raw.components)).toBe(true);
    expect(Array.isArray(raw.steps)).toBe(true);
    expect(raw.steps).toEqual([]);
  });

  it("appendStep (pending) -> markStepDone -> readJournal reflects status; no partial temp file observable", () => {
    createJournal();
    appendStep({ path: "/tmp/a", action: "created" });
    let j = readJournal();
    expect(j!.steps).toHaveLength(1);
    expect(j!.steps[0].status).toBe("pending");
    expect(j!.steps[0].step).toBe(0);

    // Atomicity: the temp file is renamed into place, never left behind.
    expect(fs.existsSync(journalPath() + ".tmp")).toBe(false);

    markStepDone(0);
    j = readJournal();
    expect(j!.steps[0].status).toBe("done");
    expect(j!.steps[0].ts).toEqual(expect.any(String));
    // journal-only fields are present in-flight
    expect(j!.steps[0]).toHaveProperty("step");
    expect(j!.steps[0]).toHaveProperty("status");
  });

  it("commitJournal commits only done entries (journal fields stripped) and deletes the journal", () => {
    createJournal({ components: ["cli", "api"] });
    appendStep({ path: "/tmp/done1", action: "created" });
    appendStep({ path: "/tmp/done2", action: "created", marker: "ORCY-SHIM" });
    appendStep({ path: "/tmp/pending", action: "fenced" });
    appendStep({ path: "/tmp/failed", action: "copied" });
    markStepDone(0);
    markStepDone(1);
    markStepFailed(3, "boom");

    expect(journalExists()).toBe(true);
    const manifest = commitJournal();

    // manifest produced from done entries only
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(1);
    expect(manifest!.components).toEqual(["cli", "api"]);
    expect(manifest!.files).toHaveLength(2);
    expect(manifest!.files.map((f) => f.path)).toEqual(["/tmp/done1", "/tmp/done2"]);

    // journal-only fields stripped -> pure ManifestEntry shape
    for (const f of manifest!.files) {
      expect(f).not.toHaveProperty("step");
      expect(f).not.toHaveProperty("status");
      expect(f).not.toHaveProperty("ts");
      expect(f).not.toHaveProperty("error");
      expect(f).not.toHaveProperty("phase");
    }
    // optional manifest fields are preserved where present
    expect(manifest!.files[1].marker).toBe("ORCY-SHIM");

    // manifest file exists at MANIFEST_PATH; journal deleted
    expect(fs.existsSync(manifestPath())).toBe(true);
    expect(journalExists()).toBe(false);

    // the on-disk manifest matches the returned one
    expect(readManifestHelper()!.files).toEqual(manifest!.files);
  });

  it("commitJournal excludes pending and failed steps from the manifest", () => {
    createJournal();
    appendStep({ path: "/tmp/done", action: "created" });
    appendStep({ path: "/tmp/pending", action: "created" });
    appendStep({ path: "/tmp/failed", action: "created" });
    markStepDone(0);
    markStepFailed(2, "nope");

    const manifest = commitJournal();
    expect(manifest!.files).toHaveLength(1);
    expect(manifest!.files[0].path).toBe("/tmp/done");
  });

  it("addJournalComponent dedups (adding twice -> one component)", () => {
    createJournal();
    addJournalComponent("cli");
    addJournalComponent("api");
    addJournalComponent("cli"); // dup
    const j = readJournal();
    expect(j!.components).toEqual(["cli", "api"]);
  });

  it("readJournal returns null for a corrupt journal", () => {
    fs.writeFileSync(journalPath(), "{ not valid json", "utf-8");
    expect(readJournal()).toBeNull();
  });

  it("readJournal returns null when the journal is absent", () => {
    expect(journalExists()).toBe(false);
    expect(readJournal()).toBeNull();
  });

  it("discardJournal removes the journal and is a no-op when absent", () => {
    createJournal();
    expect(journalExists()).toBe(true);
    discardJournal();
    expect(journalExists()).toBe(false);
    // no-op when absent (does not throw)
    expect(() => discardJournal()).not.toThrow();
  });
});

describe("G3 two-phase sub-stepping shape", () => {
  it("models the registerAgent post -> credentials -> done transitions with status pending until done", () => {
    createJournal();
    appendStep({ path: `${orcyHome()}/credentials.json`, action: "created", phase: "post" });

    // (1) POST-pending: phase "post", status pending -> POST never attempted
    let j = readJournal()!;
    expect(j.steps[0].phase).toBe("post");
    expect(j.steps[0].status).toBe("pending");
    expect(j.steps[0].phasePayload).toBeUndefined();

    // (2) POST succeeded: advance to "credentials", capture agentId, status STILL pending
    setStepPhase(0, "credentials", { agentId: "agent-xyz" });
    j = readJournal()!;
    expect(j.steps[0].phase).toBe("credentials");
    expect(j.steps[0].status).toBe("pending"); // <- not done yet
    expect(j.steps[0].phasePayload).toEqual({ agentId: "agent-xyz" });

    // (3) credentials written: mark done
    markStepDone(0);
    j = readJournal()!;
    expect(j.steps[0].status).toBe("done");

    // A done registerAgent entry still commits to a plain ManifestEntry.
    const manifest = commitJournal();
    expect(manifest!.files).toHaveLength(1);
    expect(manifest!.files[0]).toEqual({
      path: `${orcyHome()}/credentials.json`,
      action: "created",
    });
  });

  it("lets a stale reader distinguish POST-never-attempted from POST-done-cred-failed", () => {
    createJournal();
    appendStep({ path: `${orcyHome()}/credentials.json`, action: "created", phase: "post" });
    // simulate POST succeeded but credential write did NOT complete
    setStepPhase(0, "credentials", { agentId: "agent-abc" });

    const j = readJournal()!;
    const e = j.steps[0];
    // viability-check logic a stale reader (P1.3/P1.4) will perform:
    const postSucceededButCredWriteFailed =
      e.status === "pending" && e.phase === "credentials" && !!e.phasePayload?.agentId;
    expect(postSucceededButCredWriteFailed).toBe(true);

    // contrast: a fresh "post" phase with no payload means POST never attempted
    createJournal();
    appendStep({ path: `${orcyHome()}/credentials.json`, action: "created", phase: "post" });
    const e2 = readJournal()!.steps[0];
    const postNeverAttempted =
      e2.status === "pending" && e2.phase === "post" && !e2.phasePayload?.agentId;
    expect(postNeverAttempted).toBe(true);
  });
});

describe("commit crash-safety", () => {
  it("journalExists() signals stale when both manifest and journal are present (crash-mid-commit window)", () => {
    // Materializes the post-writeManifest / pre-unlink crash state: BOTH files on
    // disk. The next start sees journalExists() === true -> treats the journal as
    // stale and deletes it; the manifest is authoritative. (The contract P1.4
    // relies on. Verified here without mocking writeManifest.)
    createJournal({ components: ["cli"] });
    appendStep({ path: "/tmp/done", action: "created" });
    markStepDone(0);
    commitJournal(); // produces a real, committed manifest
    expect(journalExists()).toBe(false);

    // now simulate the crash window: a journal re-appears alongside the manifest
    createJournal({ components: ["cli"] });
    appendStep({ path: "/tmp/done2", action: "created" });
    markStepDone(0);

    expect(fs.existsSync(manifestPath())).toBe(true);
    expect(journalExists()).toBe(true); // <- stale signal
  });

  it("commitJournal preserves the journal when writeManifest throws (commit is atomic)", async () => {
    // Faithful atomicity test: replace writeManifest with a throwing stub for this
    // test only (vi.doMock + vi.resetModules + dynamic import), then verify the
    // journal is NOT unlinked when the manifest write fails -> the commit is
    // retryable. Atomicity comes from commitJournal's writeManifest-then-unlink
    // ordering: if writeManifest throws, the unlink is unreachable.
    createJournal({ components: ["cli"] });
    appendStep({ path: "/tmp/done", action: "created" });
    markStepDone(0);
    const beforeSteps = readJournal()!.steps;

    vi.resetModules();
    vi.doMock("../src/manifest.js", () => ({
      readManifest: () => null,
      writeManifest: () => {
        throw new Error("commit boom");
      },
    }));
    const { commitJournal: commitJournalMocked } = await import("../src/journal.js");

    expect(() => commitJournalMocked()).toThrow("commit boom");
    // journal untouched: still present, steps unchanged, no manifest produced
    expect(journalExists()).toBe(true);
    expect(readJournal()!.steps).toEqual(beforeSteps);
    expect(fs.existsSync(manifestPath())).toBe(false);

    vi.doUnmock("../src/manifest.js");
  });

  it("commitJournal is idempotent: re-committing a complete journal produces the manifest; a second call returns the existing one", () => {
    // Edge case: all steps done but no manifest yet (crash before commit rename).
    createJournal({ components: ["api"] });
    appendStep({ path: "/tmp/done", action: "created" });
    markStepDone(0);

    const m1 = commitJournal();
    expect(m1!.files).toHaveLength(1);
    expect(journalExists()).toBe(false);

    // second commit: journal absent -> returns the already-committed manifest, no throw
    const m2 = commitJournal();
    expect(m2).not.toBeNull();
    expect(m2!.files).toEqual(m1!.files);
  });

  it("commitJournal returns null when neither journal nor manifest exist", () => {
    expect(commitJournal()).toBeNull();
  });
});
