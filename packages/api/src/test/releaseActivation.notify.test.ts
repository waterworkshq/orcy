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
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import { findRemoteRecipientsForEvent } from "../services/remoteNotificationResolver.js";
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

// GROUND: MIGRATION-TASKS T8 8.1 — P2 release remote-pool fixtures (helper
// bodies mirror the T6.3/T8 seed shapes; used by the P2 describe below).
function seedParticipant(habId: string, name: string) {
  const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId: habId, name: `pod-${name}` }).id)!;
  const p = participantRepo.activateRemoteParticipant(
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id, habitatId: habId, participantType: "remote_human",
      displayName: name, standing: "remote_contributor",
    }).id,
  )!;
  return { podId: pod.id, participantId: p.id };
}
function seedGrant(habId: string, podId: string, participantId: string, target?: { targetType: "task" | "mission" | "habitat"; targetId: string }) {
  const grant = grantRepo.createRemoteGrant({
    habitatId: habId, remotePodId: podId, remoteParticipantId: participantId,
    grantType: "scoped_elevation", standing: "remote_contributor", actionScopes: ["read"],
  });
  if (target) grantRepo.addRemoteGrantTarget(grant.id, target.targetType, target.targetId);
  return grant;
}

// GROUND: MIGRATION-TASKS T8 8.1 / TASKS T8 — P2 release narrows
// deliberately from the untargeted all-grants pool to the explicit habitat
// target (owner-approved fail-closed narrowing); habitat_members replaces
// the members-only helper so an owned personal habitat's owner is served.
describe("P2 release — members + habitat-target pool (deliberate narrowing)", () => {
  // GROUND: MIGRATION-TASKS T8 8.1 — the new intended selection: members
  // plus the habitat-targeted remote pool, equality derived from
  // findRemoteRecipientsForEvent on the same target (§0 dedup rule).
  it("release.activated reaches members and the HABITAT-TARGETED remote pool (new intended selection)", async () => {
    const gh = seedParticipant(habitatId, "rel-grant");
    seedGrant(habitatId, gh.podId, gh.participantId, { targetType: "habitat", targetId: habitatId });
    subscriptionRepo.createSubscription({ habitatId, scope: "habitat_default", eventType: "release.activated",
      enabled: true, required: false, channels: ["in_app"], cadence: "immediate" });
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { releaseType: "minor", detectedBy: "api" });
    seedGatedPatchMission("intent-pool-finding");
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", { detectedBy: "api" });
    const events = eventRepo.listNotificationEventsByHabitat(habitatId).events;
    const activated = events.find((e) => e.eventType === "release.activated")!;
    const ids = deliveryRepo.getDeliveriesByEvent(activated.id).map((d) => d.recipientId);
    expect(ids).toContain(memberUserId);      // team-member parity with today
    expect(ids).toContain(gh.participantId);  // habitat-target pool delivered
    const expected = findRemoteRecipientsForEvent({ habitatId, eventType: "release.activated", targetType: "habitat", targetId: habitatId });
    const remoteGot = deliveryRepo.getDeliveriesByEvent(activated.id)
      .filter((d) => d.recipientType.startsWith("remote"))
      .map((d) => ({ recipientType: d.recipientType, recipientId: d.recipientId }));
    expect(remoteGot.sort()).toEqual([...expected].sort());
  });

  // GROUND: TASKS T8 bullet 3 / MIGRATION-TASKS 8.1 — owned/unowned personal
  // behavior: an owned PERSONAL habitat's release reaches its owner (was
  // Event-only under the team-only helper — adopted DESIGN §6 delta).
  it("owned PERSONAL habitat release reaches its owner (was Event-only) — flip the seeded habitat in-place, no new fixture", async () => {
    getDb().update(habitats).set({ teamId: null, ownerUserId: memberUserId })
      .where(eq(habitats.id, habitatId)).run();          // owner XOR team satisfied in-place
    subscriptionRepo.createSubscription({ habitatId, scope: "habitat_default", eventType: "release.activated",
      channels: ["in_app"], cadence: "immediate" });     // habitat-default shape used by the host suite
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { releaseType: "minor", detectedBy: "api" });
    seedGatedPatchMission("owned-personal");
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", { detectedBy: "api" });
    const activated = eventRepo.listNotificationEventsByHabitat(habitatId).events
      .find((e) => e.eventType === "release.activated")!;
    const ids = deliveryRepo.getDeliveriesByEvent(activated.id).map((d) => d.recipientId);
    expect(ids).toContain(memberUserId);   // the owner — previously Event-only (adopted delta)
  });

  // GROUND: MIGRATION-TASKS §0 P2 policy — the narrowing discriminator: an
  // active-grant participant whose grant does not pass habitat visibility
  // received a delivery yesterday (untargeted all-grants pool) and receives
  // none under the adopted habitat-target selection.
  it("narrowing discriminator: an active MISSION-scoped grant was in the OLD untargeted pool and gets NO release delivery now", async () => {
    subscriptionRepo.createSubscription({ habitatId, scope: "habitat_default", eventType: "release.activated",
      channels: ["in_app"], cadence: "immediate" });
    const unrelatedMission = missionRepo.createMission({ habitatId, title: "Unrelated", priority: "medium", createdBy: memberUserId });
    const gh = seedParticipant(habitatId, "narrow-grant");
    seedGrant(habitatId, gh.podId, gh.participantId, { targetType: "mission", targetId: unrelatedMission.id });
    const untargeted = findRemoteRecipientsForEvent({ habitatId, eventType: "release.activated" });
    const targeted = findRemoteRecipientsForEvent({ habitatId, eventType: "release.activated", targetType: "habitat", targetId: habitatId });
    expect(untargeted.some((r) => r.recipientId === gh.participantId)).toBe(true);   // yesterday's behavior
    expect(targeted.some((r) => r.recipientId === gh.participantId)).toBe(false);    // the deliberate narrowing
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { releaseType: "minor", detectedBy: "api" });
    seedGatedPatchMission("narrow-personal");
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", { detectedBy: "api" });
    const activated = eventRepo.listNotificationEventsByHabitat(habitatId).events
      .find((e) => e.eventType === "release.activated")!;
    expect(deliveryRepo.getDeliveriesByEvent(activated.id).some((d) => d.recipientId === gh.participantId)).toBe(false);
  });
});

// Suppress unused-symbol diagnostics for schema imports retained for clarity.
void teamMembers;
