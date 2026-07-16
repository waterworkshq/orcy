import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { pulses, findingTriage as findingTriageTable } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as findingTriageService from "../services/findingTriageService.js";
import { ingestEvent } from "../services/automationEventService.js";

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Finding Triage Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Finding Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => closeDb());

const ACTOR = { type: "human" as const, id: "user-1" };

/** Seed a structured finding pulse. */
function seedFinding(opts: {
  subject: string;
  findingKind?: string;
  severity?: string;
  blocksCurrentWork?: boolean;
  fromId?: string;
  metadata?: Record<string, unknown>;
}) {
  return pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: opts.fromId ?? "agent-1",
    signalType: "finding",
    subject: opts.subject,
    body: "",
    metadata: {
      findingKind: opts.findingKind ?? "bug",
      severity: opts.severity ?? "minor",
      blocksCurrentWork: opts.blocksCurrentWork ?? false,
      ...opts.metadata,
    },
  });
}

describe("findingTriage", () => {
  it("AC-FINDING-1: critical finding fires automation rule via pulse.signal_posted", async () => {
    ruleRepo.createAutomationRule({
      habitatId,
      name: "Critical Finding Rule",
      priority: 0,
      trigger: { type: "event", eventType: "pulse.signal_posted" } as any,
      enabled: true,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "system:test",
    });

    // Post a critical, work-blocking finding then emit the signal_posted event.
    const finding = seedFinding({
      subject: "prod db down",
      severity: "critical",
      blocksCurrentWork: true,
    });
    const result = await ingestEvent(habitatId, {
      type: "pulse.signal_posted",
      data: { pulseId: finding.id, eventId: `evt-${finding.id}` },
    });

    expect(result.matched).toBe(1);
  });

  it("AC-FINDING-2: entering triage creates finding_triage record with status open", () => {
    const finding = seedFinding({ subject: "broken build step", findingKind: "build" });
    const { findingTriageId } = findingTriageService.enterTriage({
      id: finding.id,
      habitatId,
      subject: finding.subject,
      metadata: finding.metadata,
    });

    const record = findingTriageRepo.getById(findingTriageId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("open");
    expect(record!.findingKind).toBe("build");
    expect(record!.habitatId).toBe(habitatId);
  });

  it("AC-FINDING-3: bidirectional linkage — pulseId FK + pulse metadata findingTriageId", () => {
    const finding = seedFinding({ subject: "linkage finding", findingKind: "bug" });
    const { findingTriageId } = findingTriageService.enterTriage({
      id: finding.id,
      habitatId,
      subject: finding.subject,
      metadata: finding.metadata,
    });

    // finding_triage.pulseId → source pulse
    const record = findingTriageRepo.getById(findingTriageId);
    expect(record!.pulseId).toBe(finding.id);

    // pulse.metadata.findingTriageId → finding_triage record
    const refreshedPulse = pulseRepo.getPulseById(finding.id);
    expect(refreshedPulse!.metadata.findingTriageId).toBe(findingTriageId);
  });

  it("AC-FINDING-4: valid status transitions accepted, invalid rejected", () => {
    const finding = seedFinding({ subject: "transition finding", findingKind: "bug" });
    const { findingTriageId } = findingTriageService.enterTriage({
      id: finding.id,
      habitatId,
      subject: finding.subject,
      metadata: finding.metadata,
    });

    // open → triaged (valid)
    findingTriageService.confirmBucket(findingTriageId, "fix_now", ACTOR);
    expect(findingTriageRepo.getById(findingTriageId)!.status).toBe("triaged");

    // triaged → in_progress via promote (valid)
    findingTriageService.promote(findingTriageId, ACTOR);
    expect(findingTriageRepo.getById(findingTriageId)!.status).toBe("in_progress");

    // in_progress → resolved (valid)
    findingTriageService.resolve(findingTriageId, "fixed in patch", ACTOR);
    expect(findingTriageRepo.getById(findingTriageId)!.status).toBe("resolved");

    // resolved → triaged (invalid — resolved only allows recurrence to open)
    expect(() => findingTriageRepo.transitionStatus(findingTriageId, "triaged", ACTOR)).toThrow();
  });

  it("AC-FINDING-5: bucket assignment recorded on finding_triage record", () => {
    const finding = seedFinding({ subject: "bucket finding", findingKind: "bug" });
    const { findingTriageId } = findingTriageService.enterTriage({
      id: finding.id,
      habitatId,
      subject: finding.subject,
      metadata: finding.metadata,
    });

    // Initially null
    expect(findingTriageRepo.getById(findingTriageId)!.bucket).toBeNull();

    // Assign each bucket type via setBucket + confirmBucket
    for (const bucket of [
      "fix_now",
      "defer_to_patch",
      "defer_to_release",
      "document_as_known_limitation",
      "needs_investigation",
    ] as const) {
      findingTriageRepo.setBucket(findingTriageId, bucket);
      expect(findingTriageRepo.getById(findingTriageId)!.bucket).toBe(bucket);
    }
  });

  it("AC-FINDING-6: duplicate finding (same clusterKey+kind) links as corroborating", () => {
    const first = seedFinding({ subject: "dup finding subject", findingKind: "bug" });
    const { findingTriageId: firstId } = findingTriageService.enterTriage({
      id: first.id,
      habitatId,
      subject: first.subject,
      metadata: first.metadata,
    });

    // Second finding with same subject + findingKind from a different agent.
    const dup = seedFinding({
      subject: "dup finding subject",
      findingKind: "bug",
      fromId: "agent-2",
    });
    const { findingTriageId: secondId } = findingTriageService.enterTriage({
      id: dup.id,
      habitatId,
      subject: dup.subject,
      metadata: dup.metadata,
    });

    // Same record — corroborating, not a new triage record.
    expect(secondId).toBe(firstId);
    const record = findingTriageRepo.getById(firstId)!;
    expect(record.corroboratingPulseIds).toContain(dup.id);
    expect(record.corroboratingPulseIds).toContain(first.id);
    // Only one finding_triage row exists for this clusterKey+kind.
    const db = getDb();
    const all = db
      .select()
      .from(findingTriageTable)
      .where(eq(findingTriageTable.habitatId, habitatId))
      .all();
    expect(all).toHaveLength(1);
  });
});
