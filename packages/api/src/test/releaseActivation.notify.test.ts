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
import * as habitatRepo from "../repositories/board.js";
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

  // Habitat scoped to a team so the human member is a real recipient.
  const org = orgRepo.createOrganization({ name: "Notify Org", slug: "notify-org" });
  const team = teamRepo.createTeam({
    organizationId: org.id,
    name: "Notify Team",
    slug: "notify-team",
  });
  const habitat = habitatRepo.createHabitat({ name: "Notify Habitat", teamId: team.id });
  habitatId = habitat.id;

  // Seed a human user + team membership so the resolver has a real recipient.
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

function seedTriagedPatchFinding(subject: string) {
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
  findingTriageRepo.setTargetReleaseType(t.id, "patch");
  return t;
}

/**
 * AC-ACTIVATE-9 — notifications fire on each auto-promotion batch, delivered
 * to all human habitat members. The recipient model is subscription-based:
 * the resolver produces deliveries for explicit recipients (passed by the
 * caller) and remote participants (via cross-pod grants). A habitat-default
 * subscription configures channels/cadence for resolved recipients but does
 * NOT itself enumerate recipients — so the test seeds both (a) a habitat-
 * default subscription to enable the event type, and (b) the seed recipient
 * via an explicit recipient_override that the resolver consults.
 */
describe("AC-ACTIVATE-9: release.activated notification fires on auto-promotion", () => {
  it("creates a notification_deliveries row for release.activated when findings promote", async () => {
    // Seed habitat-default subscription enabling release.activated.
    subscriptionRepo.createSubscription({
      habitatId,
      scope: "habitat_default",
      eventType: "release.activated",
      enabled: true,
      required: false,
      channels: ["in_app"],
      cadence: "immediate",
    });
    // Seed a recipient_override so the resolver treats this user as an
    // eligible recipient for release.activated. (The resolver iterates only
    // explicit recipients; habitat-default subscriptions configure delivery
    // but do not themselves enumerate recipients.)
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
    seedTriagedPatchFinding("notify-finding");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    // The activation produced at least one promotion, so the notification fires.
    expect(result.promotedCount).toBe(1);

    // BUG-CANDIDATE: the resolver does not enumerate habitat team members.
    // detectAndActivate calls enqueueNotification WITHOUT explicitRecipients,
    // and the resolver returns an empty delivery list when explicitRecipients
    // is empty (regardless of habitat-default subscriptions). For a delivery
    // to exist for memberUserId, EITHER (a) detectAndActivate must fan out to
    // team members as explicit recipients, OR (b) the resolver must enumerate
    // team members when a habitat-default subscription exists. As written, the
    // notification_event row is created but ZERO deliveries are produced in
    // a pure-local (no remote grants) habitat.
    const db = getDb();
    const deliveriesForMember = db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.recipientId, memberUserId))
      .all();
    expect(deliveriesForMember.length).toBeGreaterThanOrEqual(1);
  });

  it("the release.activated notification event is recorded even without subscriptions", async () => {
    // No subscription seeding — the event row is still recorded because
    // detectAndActivate calls enqueueNotification unconditionally on a
    // non-zero promotion batch.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedTriagedPatchFinding("no-sub-finding");

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
