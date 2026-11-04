// GROUND: MIGRATION-TASKS T8 8.1 / TASKS T8 — producer migration III:
// release, budget, webhook, recovery (N2, N8-P2/P3/P7/P6). This file carries
// the standalone P6 recovery and P3 budget pool-preservation + audience
// cells; the P7 webhook and P2 release cells extend their existing host
// suites (compactRemoteWebhookFailures.test.ts, releaseActivation.notify.test.ts)
// per the in-block placement notes. Expected remote sets are always derived
// from findRemoteRecipientsForEvent for the same arguments (§0 dedup rule).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { users, teamMembers, teams, organizations, habitats } from "../db/schema/index.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import { findRemoteRecipientsForEvent } from "../services/remoteNotificationResolver.js";
import { emitRecoveryNotification } from "../services/workflow/recoveryNotifications.js";
import { escalateTransitionBudgetBreach } from "../services/tasks/transitionBudgetEscalation.js";
import type { BudgetRefusedOutcome } from "../services/tasks/transitionBudget.js";

beforeEach(async () => { await initTestDb(); });
afterEach(async () => { await closeDb(); });

// Exact constructors (verified interfaces; fixture chain:
// organizations → teams → teamMembers → habitats as direct drizzle inserts,
// users role ∈ admin|editor|viewer; teamMembers ids are explicit — text PK,
// no drizzle default).
function seedUser(id: string, role: "admin" | "editor" | "viewer" = "editor") {
  getDb().insert(users).values({ id, username: id, passwordHash: "x", displayName: id, role }).run();
}
function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
function seedTeamHabitat(memberRoles: Array<{ userId: string; memberRole: "owner" | "admin" | "member" }>) {
  const db = getDb();
  const orgId = uid("org"); const teamId = uid("team"); const habitatId = uid("hab");
  db.insert(organizations).values({ id: orgId, name: "O", slug: orgId }).run();
  db.insert(teams).values({ id: teamId, organizationId: orgId, name: "T", slug: teamId }).run();
  db.insert(habitats).values({ id: habitatId, name: "H", teamId }).run();
  for (const m of memberRoles) {
    seedUser(m.userId);
    db.insert(teamMembers).values({ id: uid("tm"), teamId, userId: m.userId, role: m.memberRole }).run();
  }
  return habitatId;
}
function seedDefault(habitatId: string, eventType: string) {
  subscriptionRepo.createSubscription({
    habitatId, scope: "habitat_default", eventType,
    enabled: true, required: false, channels: ["in_app"], cadence: "immediate",
  });
}
function seedTaskInHabitat(habId: string): string {
  columnRepo.createColumn({ habitatId: habId, name: "Col", order: 0 });
  const mission = missionRepo.createMission({ habitatId: habId, title: "M", priority: "medium", createdBy: "user-1" });
  return taskRepo.createTask({ missionId: mission.id, title: "T", description: "", requiredCapabilities: [], labels: [], createdBy: "user-1" }).id;
}
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
function deliveriesOfLastEvent(habitatId: string) {
  // listNotificationEventsByHabitat returns { events, total }, newest-first
  const event = eventRepo.listNotificationEventsByHabitat(habitatId).events[0]!;
  return { event, deliveries: deliveryRepo.getDeliveriesByEvent(event.id) };
}
// Recipient-set comparator: Array#sort with no comparator stringifies objects
// (all "[object Object]") and reorders nothing — sort by a stable key instead.
const byRecipientKey = (
  a: { recipientType: string; recipientId: string },
  b: { recipientType: string; recipientId: string },
) => `${a.recipientType}:${a.recipientId}`.localeCompare(`${b.recipientType}:${b.recipientId}`);

describe("P6 recovery — operators UNION task-targeted remote pool", () => {
  // GROUND: TASKS T8 bullet 1/3 — recovery operators union supported task
  // peer population; remote pool preserved byte-equal on the task target.
  it("remote pool deliveries are preserved exactly; local operators are additive", () => {
    const h = seedTeamHabitat([{ userId: "op-1", memberRole: "admin" }, { userId: "mem-2", memberRole: "member" }]);
    seedDefault(h, "workflow.recovery_started");
    const taskId = seedTaskInHabitat(h);
    const gh = seedParticipant(h, "recovery-grant");
    seedGrant(h, gh.podId, gh.participantId, { targetType: "task", targetId: taskId });
    emitRecoveryNotification(h, "workflow.recovery_started", "Recovery", { recoveryTaskId: taskId });
    const { deliveries } = deliveriesOfLastEvent(h);
    const expected = findRemoteRecipientsForEvent({ habitatId: h, eventType: "workflow.recovery_started", targetType: "task", targetId: taskId });
    const remoteGot = deliveries.filter((d) => d.recipientType.startsWith("remote")).map((d) => ({ recipientType: d.recipientType, recipientId: d.recipientId }));
    expect([...remoteGot].sort(byRecipientKey)).toEqual([...expected].sort(byRecipientKey));
    expect(deliveries.map((d) => d.recipientId)).toContain("op-1");   // additive local operator
    expect(deliveries.map((d) => d.recipientId)).not.toContain("mem-2"); // members are not operators
  });
  // GROUND: MIGRATION-TASKS §0 P6 policy + TASKS T8 bullet 2 — no task ids
  // ⇒ operators only, NO remote audience (adopted: never untargeted
  // broadcast), classified and logged.
  // Review pr-168: the task existence probe must be habitat-scoped — a
  // payload id naming a task in another habitat classifies as no supported
  // target (operators-only degrade), never a foreign remote pool and never
  // a thrown-away event.
  it("foreign-habitat task id ⇒ operators only, event still emitted, no remote audience", () => {
    const h = seedTeamHabitat([{ userId: "op-1", memberRole: "admin" }]);
    const other = seedTeamHabitat([{ userId: "op-2", memberRole: "admin" }]);
    seedDefault(h, "workflow.recovery_succeeded");
    const foreignTask = seedTaskInHabitat(other);
    const gh = seedParticipant(h, "foreign-grant");
    seedGrant(h, gh.podId, gh.participantId, { targetType: "task", targetId: foreignTask }); // local grant aimed at foreign task — must not leak
    emitRecoveryNotification(h, "workflow.recovery_succeeded", "Done", { recoveryTaskId: foreignTask });
    const { deliveries } = deliveriesOfLastEvent(h); // throws if the event was dropped wholesale
    expect(deliveries.map((d) => d.recipientId)).toContain("op-1");
    expect(deliveries.every((d) => !d.recipientType.startsWith("remote"))).toBe(true);
    expect(deliveries.map((d) => d.recipientId)).not.toContain("op-2"); // foreign habitat's operators never enlisted
  });
  it("no task ids in payload ⇒ operators only, NO remote audience (adopted: never untargeted broadcast), classified", () => {
    const h = seedTeamHabitat([{ userId: "op-1", memberRole: "admin" }]);
    seedDefault(h, "workflow.recovery_unrecoverable");
    const gh = seedParticipant(h, "pool-holder");
    seedGrant(h, gh.podId, gh.participantId);   // active untargeted-discovery grant — must NOT gain a delivery without a supported target
    emitRecoveryNotification(h, "workflow.recovery_unrecoverable", "Unrecoverable", {});
    const { deliveries } = deliveriesOfLastEvent(h);
    expect(deliveries.every((d) => !d.recipientType.startsWith("remote"))).toBe(true);
    expect(deliveries.map((d) => d.recipientId)).toContain("op-1");
  });
});

describe("P3 budget breach — operators + task-targeted pool", () => {
  // GROUND: TASKS T8 bullet 3 — no all-admin broadcast when scoped
  // responsibility exists (fallback only when unserved); task pool
  // preserved byte-equal; members-only audience becomes operators (adopted).
  it("scoped operators (not all members) receive breach; task pool preserved; served habitat does not fall back", () => {
    const h = seedTeamHabitat([{ userId: "op-1", memberRole: "owner" }, { userId: "mem-2", memberRole: "member" }]);
    seedUser("global-admin", "admin");
    seedDefault(h, "task.blocked");
    const taskId = seedTaskInHabitat(h);
    const gh = seedParticipant(h, "budget-grant");
    seedGrant(h, gh.podId, gh.participantId, { targetType: "task", targetId: taskId });
    // refused literal carries exactly the two fields the escalation body reads
    const refused = { ceiling: 5, count: 5 } as BudgetRefusedOutcome;
    escalateTransitionBudgetBreach(taskId, h, refused, "submitted", "agent");
    const { deliveries } = deliveriesOfLastEvent(h);
    const ids = deliveries.map((d) => d.recipientId);
    expect(ids).toContain("op-1");
    expect(ids).not.toContain("mem-2");       // was members-only; now operators (adopted)
    expect(ids).not.toContain("global-admin"); // fallback only when unserved
    const expected = findRemoteRecipientsForEvent({ habitatId: h, eventType: "task.blocked", targetType: "task", targetId: taskId });
    const remoteGot = deliveries.filter((d) => d.recipientType.startsWith("remote")).map((d) => ({ recipientType: d.recipientType, recipientId: d.recipientId }));
    expect([...remoteGot].sort(byRecipientKey)).toEqual([...expected].sort(byRecipientKey));
  });
  // Same escalation path, habitat deliberately unserved (no owner/admin team
  // roles) ⇒ resolveHabitatOperators scoped set is empty and the N2 fallback
  // to global admins is the only audience.
  it("unserved habitat (no owner/admin team roles) falls back to global admins", () => {
    const h = seedTeamHabitat([{ userId: "mem-1", memberRole: "member" }]);
    seedUser("global-admin", "admin");
    seedDefault(h, "task.blocked");
    const taskId = seedTaskInHabitat(h);
    const refused = { ceiling: 5, count: 5 } as BudgetRefusedOutcome;
    escalateTransitionBudgetBreach(taskId, h, refused, "submitted", "agent");
    const { deliveries } = deliveriesOfLastEvent(h);
    const ids = deliveries.map((d) => d.recipientId);
    expect(ids).toContain("global-admin"); // unserved ⇒ N2 fallback fires
    expect(ids).not.toContain("mem-1");    // members never inherit operator duty
  });
});
