import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  notificationEvents,
  notificationDeliveries,
  teamMembers,
  users,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";

let habitatId: string;
let columnId: string;
let missionId: string;
let memberUserId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(notificationEvents).run();
  db.delete(notificationDeliveries).run();

  const org = orgRepo.createOrganization({ name: "Notify Org", slug: "notify-org" });
  const team = teamRepo.createTeam({
    organizationId: org.id,
    name: "Notify Team",
    slug: "notify-team",
  });
  const habitat = habitatRepo.createHabitat({ name: "Notify Habitat", teamId: team.id });
  habitatId = habitat.id;

  memberUserId = "user-release-member";
  db.insert(users)
    .values({
      id: memberUserId,
      username: memberUserId,
      passwordHash: "hash",
      displayName: "Release Member",
      role: "admin",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  memberRepo.addMember({ teamId: team.id, userId: memberUserId, role: "member" });

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
    title: "Seed",
    createdBy: memberUserId,
  });
  missionId = mission.id;
});

afterEach(() => closeDb());

const ACTOR = { type: "human" as const, id: "user-1" };

/**
 * Migrated seeding: a patch-gated mission linked to a triaged finding. The
 * notification mechanism is preserved; only the seeding fixture moves from
 * free-floating finding → gated mission. The widened notification guard
 * (`promotedCount > 0 || activatedMissionCount > 0`) fires on gate activation.
 */
function seedGatedPatchMission(subject: string) {
  const gatedMission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `gated-${subject}`,
    createdBy: "triage-agent",
    releaseGateType: "patch",
  });
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject,
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  const t = findingTriageRepo.createForPulse(pulse);
  findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
  findingTriageRepo.setBucket(t.id, "defer_to_patch");
  findingTriageRepo.setTriageMissionId(t.id, gatedMission.id);
  return { mission: gatedMission, finding: t };
}

/**
 * AC-ACTIVATE-9 — notifications fire on each activation batch, delivered to
 * all human habitat members. Recipient model: subscription-based; habitat-
 * default subscriptions configure channels/cadence, explicit recipient_override
 * enumerates the recipient (mirrors the v0.24.0 test).
 */
describe("AC-ACTIVATE-9: release.activated notification fires on gate activation", () => {
  it("creates a notification_deliveries row for release.activated when a gate resolves", async () => {
    subscriptionRepo.createSubscription({
      habitatId,
      scope: "habitat_default",
      eventType: "release.activated",
      enabled: true,
      required: false,
      channels: ["in_app"],
      cadence: "immediate",
    });
    subscriptionRepo.createSubscription({
      habitatId,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: memberUserId,
      eventType: "release.activated",
      enabled: true,
      channels: ["in_app"],
      cadence: "immediate",
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedGatedPatchMission("notify-finding");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    // The widened guard fired the notification via activatedMissionCount > 0
    // (promotedCount is 0 — gate path, not legacy).
    expect(result.promotedCount).toBe(0);

    const db = getDb();
    const deliveriesForMember = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.recipientId, memberUserId))
      .all();
    expect(deliveriesForMember.length).toBeGreaterThanOrEqual(1);
  });

  it("the release.activated notification event is recorded even without subscriptions", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedGatedPatchMission("no-sub-finding");

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    const db = getDb();
    const events = db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.habitatId, habitatId))
      .all()
      .filter((e) => e.eventType === "release.activated");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

// Suppress unused-symbol diagnostics for schema imports retained for clarity.
void teamMembers;
void habitats;
