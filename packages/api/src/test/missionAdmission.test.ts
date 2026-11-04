// Real-storage admission discriminator (T1+T2). Grounds:
// - PRD A1/A2: atomic Mission+link+candidate commit, rollback on any write or
//   readback failure, duplicate identity recheck under the writer reservation.
// - PRD A3: same-connection repeat sync stays an update; other-connection
//   provider owner yields a bounded 409 with no new rows.
// - PRD A4/A6: intake policy, closed-issue skip, and post-commit audit
//   failure-without-rollback are characterized as unchanged.
// - DESIGN §2/§3/§4: operation order, error/commit matrix, raw
//   BEGIN IMMEDIATE/COMMIT/ROLLBACK on both sql.js and native drivers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { ExternalIssue } from "@orcy/shared";
import { closeDb, getDb, initDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as candidateRepo from "../repositories/externalIntakeCandidate.js";
import * as missionRepo from "../repositories/mission.js";
import * as linkRepo from "../repositories/externalIssueLink.js";
import { promoteIntakeCandidate, syncExternalIssue } from "../services/integrations/syncService.js";

const issue = (overrides: Partial<ExternalIssue> = {}): ExternalIssue => ({
  provider: "github", externalId: "issue-1", externalKey: "acme/repo#1",
  title: "Issue", body: "Body", status: "open", labels: ["bug"],
  url: "https://github.com/acme/repo/issues/1", updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function fixture(autoImport = true) {
  const habitat = habitatRepo.createHabitat({ name: "Admission" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0, requiresClaim: false });
  const connection = connectionRepo.create({
    habitatId: habitat.id, provider: "github", name: "GitHub", authMethod: "pat",
    accessToken: "ghp_test", repositoryOwner: "acme", repositoryName: "repo",
    autoImport, pullEnabled: true, createdBy: "tester",
  });
  return { habitat, column, connection };
}

function snapshot(habitatId: string) {
  const db = getDb();
  const one = (query: ReturnType<typeof sql>) => Number((db.all(query)[0] as { c: number }).c);
  return {
    missions: one(sql`SELECT count(*) AS c FROM missions WHERE habitat_id = ${habitatId}`),
    links: one(sql`SELECT count(*) AS c FROM external_issue_links WHERE habitat_id = ${habitatId}`),
    events: one(sql`SELECT count(*) AS c FROM mission_events WHERE mission_id IN (SELECT id FROM missions WHERE habitat_id = ${habitatId})`),
  };
}

for (const driver of ["sqljs", "native"] as const) {
  describe(`admission on ${driver}`, () => {
    let dir: string | undefined;
    beforeEach(async () => {
      if (driver === "sqljs") await initTestDb();
      else { dir = mkdtempSync(join(tmpdir(), "orcy-admission-")); await initDb(join(dir, "test.sqlite")); }
    }, 120_000);
    afterEach(() => { closeDb(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

    // GROUND: PRD A1 — candidate UPDATE failure rolls back Mission+link; retry succeeds once.
    it("rolls back a later candidate write and succeeds on retry", () => {
      const f = fixture(false);
      syncExternalIssue(f.connection, issue());
      const candidate = candidateRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")!;
      expect(candidate.reviewStatus).toBe("new");
      const before = snapshot(f.habitat.id);
      getDb().run(sql`CREATE TRIGGER admission_candidate_abort BEFORE UPDATE ON external_intake_candidates BEGIN SELECT RAISE(ABORT, 'probe candidate update veto'); END`);
      let failure: unknown;
      try { promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} }); }
      catch (error) { failure = error; }
      expect(failure).toBeDefined();
      const messages: string[] = [];
      const seen = new Set<unknown>();
      for (let current: unknown = failure; current && typeof current === "object" && !seen.has(current);) {
        seen.add(current);
        const entry = current as { message?: unknown; cause?: unknown };
        messages.push(String(entry.message ?? ""));
        current = entry.cause;
      }
      expect(messages.join(" | ")).toContain("probe candidate update veto");
      expect(snapshot(f.habitat.id)).toEqual(before);
      expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "new", promotedMissionId: null });
      getDb().run(sql`DROP TRIGGER admission_candidate_abort`);
      const result = promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} });
      expect(snapshot(f.habitat.id)).toEqual({ missions: before.missions + 1, links: before.links + 1, events: before.events });
      expect(result.candidate).toMatchObject({ reviewStatus: "promoted", promotedMissionId: result.mission.id });
      expect(result.link.missionId).toBe(result.mission.id);
      expect(() => promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} })).toThrow("already been promoted");
    });

    // GROUND: PRD A2/A9 + DESIGN §2 — only a real link INSERT identity conflict maps to the bounded 409.
    it.each(["provider", "connection_id"] as const)("maps only a real %s link INSERT identity conflict after the precheck", (kind) => {
      const f = fixture(false);
      syncExternalIssue(f.connection, issue());
      const candidate = candidateRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")!;
      const prior = missionRepo.createMission({ habitatId: f.habitat.id, columnId: f.column.id, title: "Owner", createdBy: "tester" });
      const owningConnectionId = kind === "provider" ? connectionRepo.create({
        habitatId: f.habitat.id, provider: "github", name: "Other owner", authMethod: "pat", createdBy: "tester",
      }).id : f.connection.id;
      linkRepo.create({ connectionId: owningConnectionId, habitatId: f.habitat.id, missionId: prior.id,
        provider: kind === "provider" ? "github" : "jira", externalId: "issue-1",
        externalKey: "PROBE-1", externalUrl: "https://example.com/1", externalStatus: "open" });
      const before = snapshot(f.habitat.id);
      // Call-through INSERT still hits the real unique constraint; only the
      // precheck reads are suppressed to exercise the defensive insert mapper.
      const byConnection = vi.spyOn(linkRepo, "findByConnectionAndExternalId").mockReturnValue(null);
      const byProvider = vi.spyOn(linkRepo, "findByProviderAndExternalId").mockReturnValue(null);
      try {
        let failure: unknown;
        try { promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} }); }
        catch (error) { failure = error; }
        expect(failure).toMatchObject({ statusCode: 409, code: "CONFLICT", message: "External issue is already linked", details: undefined });
        expect(snapshot(f.habitat.id)).toEqual(before);
        expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "new", promotedMissionId: null });
      } finally {
        byConnection.mockRestore();
        byProvider.mockRestore();
      }
    });

    // GROUND: PRD A1/A5 — a truthy candidate reread without the promoted postimage is a failure.
    it("rolls back when candidate UPDATE reports a row but its promoted postimage did not stick", () => {
      const f = fixture(false);
      syncExternalIssue(f.connection, issue());
      const candidate = candidateRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")!;
      const before = snapshot(f.habitat.id);
      getDb().run(sql`CREATE TRIGGER admission_candidate_ignore BEFORE UPDATE ON external_intake_candidates BEGIN SELECT RAISE(IGNORE); END`);
      expect(() => promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} }))
        .toThrow("Candidate admission readback mismatch");
      expect(snapshot(f.habitat.id)).toEqual(before);
      expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "new", promotedMissionId: null });
      getDb().run(sql`DROP TRIGGER admission_candidate_ignore`);
      const retry = promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} });
      expect(retry.candidate).toMatchObject({ reviewStatus: "promoted", promotedMissionId: retry.mission.id });
    });

    // GROUND: PRD A9 — a spoofed link-uniqueness message from the candidate UPDATE propagates, not a 409.
    it("does not translate a non-link candidate error into an owner conflict", () => {
      const f = fixture(false);
      syncExternalIssue(f.connection, issue());
      const candidate = candidateRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")!;
      const before = snapshot(f.habitat.id);
      getDb().run(sql`CREATE TRIGGER admission_candidate_spoof BEFORE UPDATE ON external_intake_candidates BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: external_issue_links.provider, external_issue_links.external_id'); END`);
      let failure: unknown;
      try { promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} }); }
      catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expect((failure as { message?: string }).message).not.toBe("External issue is already linked");
      expect(snapshot(f.habitat.id)).toEqual(before);
      getDb().run(sql`DROP TRIGGER admission_candidate_spoof`);
    });

    // GROUND: PRD A1 — link INSERT failure rolls back the Mission; retry then creates and updates once.
    it("rolls back a later link write, then creates and updates once", () => {
      const f = fixture();
      const before = snapshot(f.habitat.id);
      getDb().run(sql`CREATE TRIGGER admission_link_abort BEFORE INSERT ON external_issue_links BEGIN SELECT RAISE(ABORT, 'probe link veto'); END`);
      let failure: unknown;
      try { syncExternalIssue(f.connection, issue()); } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      const messages: string[] = [];
      const seen = new Set<unknown>();
      for (let current: unknown = failure; current && typeof current === "object" && !seen.has(current);) {
        seen.add(current);
        const entry = current as { message?: unknown; cause?: unknown };
        messages.push(String(entry.message ?? ""));
        current = entry.cause;
      }
      expect(messages.join(" | ")).toContain("probe link veto");
      expect(snapshot(f.habitat.id)).toEqual(before);
      getDb().run(sql`DROP TRIGGER admission_link_abort`);
      const first = syncExternalIssue(f.connection, issue());
      const second = syncExternalIssue(f.connection, issue({ title: "Updated" }));
      expect(first.action).toBe("created");
      expect(second).toMatchObject({ action: "updated", missionId: first.missionId, linkId: first.linkId });
      expect(missionRepo.getMissionById(first.missionId)).toMatchObject({ title: "Updated", createdBy: "tester" });
      expect(snapshot(f.habitat.id)).toEqual({ missions: before.missions + 1, links: before.links + 1, events: before.events + 2 });
    });

    // GROUND: DESIGN §2 — writer-reserved duplicate recheck when the initial linked lookup misses.
    it("uses the admission recheck when the initial linked lookup misses", () => {
      const f = fixture();
      const created = syncExternalIssue(f.connection, issue());
      const before = snapshot(f.habitat.id);
      // First call after install is the top-level linked lookup in
      // syncExternalIssue; the admission recheck then falls through to the
      // real lookup and must take the existing-link path (no new Mission).
      const byConnection = vi.spyOn(linkRepo, "findByConnectionAndExternalId").mockReturnValueOnce(null);
      try {
        const late = syncExternalIssue(f.connection, issue({ title: "Late link" }));
        expect(late).toMatchObject({ action: "updated", missionId: created.missionId, linkId: created.linkId });
      } finally {
        byConnection.mockRestore();
      }
      expect(missionRepo.getMissionById(created.missionId)).toMatchObject({ title: "Late link" });
      expect(snapshot(f.habitat.id)).toEqual({ missions: before.missions, links: before.links, events: before.events + 1 });
    });

    // GROUND: PRD A3 — provider identity owned by another connection is a bounded 409, no cross-Habitat attach.
    for (const crossHabitat of [false, true]) {
      it(`refuses a provider identity on another connection (cross Habitat ${crossHabitat})`, () => {
        const owner = fixture();
        const targetHabitat = crossHabitat ? fixture().habitat : owner.habitat;
        const other = connectionRepo.create({ habitatId: targetHabitat.id, provider: "github", name: "Other", authMethod: "pat", accessToken: "ghp_other", repositoryOwner: "acme", repositoryName: "repo", autoImport: true, pullEnabled: true, createdBy: "tester" });
        const created = syncExternalIssue(owner.connection, issue());
        const beforeOwner = snapshot(owner.habitat.id);
        const beforeTarget = snapshot(targetHabitat.id);
        for (let n = 0; n < 2; n++) {
          try { syncExternalIssue(other, issue()); throw new Error("expected conflict"); }
          catch (error) { expect(error).toMatchObject({ statusCode: 409, code: "CONFLICT", message: "External issue is already linked", details: undefined }); }
        }
        expect(snapshot(owner.habitat.id)).toEqual(beforeOwner);
        expect(snapshot(targetHabitat.id)).toEqual(beforeTarget);
        expect(linkRepo.getById(created.linkId)).toMatchObject({ connectionId: owner.connection.id, missionId: created.missionId });
      });
    }

    // GROUND: PRD A3/A9 — same-connection owner also refuses promotion with no new rows.
    it("refuses promotion when the same connection already owns the identity", () => {
      const f = fixture(false);
      syncExternalIssue(f.connection, issue());
      const candidate = candidateRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")!;
      const mission = missionRepo.createMission({ habitatId: f.habitat.id, columnId: f.column.id, title: "Existing", createdBy: "tester" });
      const link = linkRepo.create({ connectionId: f.connection.id, habitatId: f.habitat.id, missionId: mission.id,
        provider: "github", externalId: "issue-1", externalKey: "acme/repo#1", externalUrl: "https://example.com/1", externalStatus: "open" });
      const before = snapshot(f.habitat.id);
      expect(() => promoteIntakeCandidate({ candidateId: candidate.id, createdBy: "tester", verifyAccess: () => {} }))
        .toThrow("External issue is already linked");
      expect(snapshot(f.habitat.id)).toEqual(before);
      expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "new", promotedMissionId: null });
      expect(linkRepo.getById(link.id)?.missionId).toBe(mission.id);
    });

    // GROUND: PRD A4 — GitHub autoImport, non-GitHub intake, and closed-new-issue skip are unchanged.
    it("preserves GitHub and non-GitHub intake policy and closed skips", () => {
      const f = fixture(false);
      const intake = syncExternalIssue(f.connection, issue());
      expect(intake.action).toBe("created");
      expect(candidateRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")).not.toBeNull();
      const jiraConnection = connectionRepo.create({ habitatId: f.habitat.id, provider: "jira", name: "Jira",
        authMethod: "pat", accessToken: "jira_test", autoImport: true, pullEnabled: true, createdBy: "tester" });
      const jiraIssue = issue({ provider: "jira", externalId: "jira-1", externalKey: "PROJ-1", url: "https://example.atlassian.net/browse/PROJ-1" });
      expect(syncExternalIssue(jiraConnection, jiraIssue).action).toBe("created");
      expect(candidateRepo.findByConnectionAndExternalId(jiraConnection.id, "jira-1")).not.toBeNull();
      const automatic = fixture(true);
      expect(syncExternalIssue(automatic.connection, issue({ externalId: "closed", status: "closed" })).action).toBe("skipped");
      expect(snapshot(automatic.habitat.id)).toEqual({ missions: 0, links: 0, events: 0 });
    });

    // GROUND: PRD A6 — post-commit audit failure propagates without undoing admission; retry finds the link.
    it("reports a post-commit audit failure without undoing admission", () => {
      const f = fixture();
      getDb().run(sql`CREATE TRIGGER admission_audit_abort BEFORE INSERT ON mission_events BEGIN SELECT RAISE(ABORT, 'audit veto'); END`);
      expect(() => syncExternalIssue(f.connection, issue())).toThrow();
      expect(snapshot(f.habitat.id)).toEqual({ missions: 1, links: 1, events: 0 });
      const link = linkRepo.findByConnectionAndExternalId(f.connection.id, "issue-1")!;
      getDb().run(sql`DROP TRIGGER admission_audit_abort`);
      const retry = syncExternalIssue(f.connection, issue({ title: "Retry" }));
      expect(retry).toMatchObject({ action: "updated", missionId: link.missionId, linkId: link.id });
      expect(snapshot(f.habitat.id)).toEqual({ missions: 1, links: 1, events: 1 });
    });
  });
}
