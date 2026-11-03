// GROUND: MIGRATION-TASKS T6 6.3 — remote lifecycle migration to the
// remote_visible intent (P5; N1/N7/N8/N10). RED on the old
// enqueueNotification producer for the adopted changes: blind explicit
// union, untargeted broadcast on missing target, and enqueue-scoped
// failure isolation. Parity cells (pool equality, explicit dedup) pin that
// the migration keeps discovery's authority unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import { findRemoteRecipientsForEvent } from "../services/remoteNotificationResolver.js";
import { emitRemoteOriginatedNotification } from "../services/remoteNotifications.js";
import * as compactDispatcher from "../services/compactRemoteWebhookDispatcher.js";
import * as intentCommand from "../services/notificationIntentCommand.js";

let habitatId: string;
let podId: string;
beforeEach(async () => {
  await initTestDb();
  habitatId = habitatRepo.createHabitat({ name: "H" }).id;
  subscriptionRepo.createSubscription({ habitatId, scope: "habitat_default", eventType: "task.assigned",
    enabled: true, required: false, channels: ["in_app"], cadence: "immediate" });
});
afterEach(async () => { await closeDb(); });

function seedTaskInHabitat(habId: string): string {
  const column = columnRepo.createColumn({ habitatId: habId, name: "Col", order: 0 });
  const mission = missionRepo.createMission({ habitatId: habId, title: "M", priority: "medium", createdBy: "user-1" });
  return taskRepo.createTask({ missionId: mission.id, title: "T", description: "", requiredCapabilities: [], labels: [], createdBy: "user-1" }).id;
}
function seedParticipant(name: string, participantType: "remote_human" | "remote_orcy" = "remote_human") {
  const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId, name: `pod-${name}` }).id)!;
  const p = participantRepo.activateRemoteParticipant(
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id, habitatId, participantType,
      displayName: name, standing: "remote_contributor",
    }).id,
  )!;
  return { podId: pod.id, participantId: p.id };
}
function seedGrant(podId: string, participantId: string, taskScopeId?: string) {
  const grant = grantRepo.createRemoteGrant({
    habitatId, remotePodId: podId, remoteParticipantId: participantId,
    grantType: "scoped_elevation", standing: "remote_contributor", actionScopes: ["read"],
  });
  if (taskScopeId) grantRepo.addRemoteGrantTarget(grant.id, "task", taskScopeId);
  return grant;
}
const baseOpts = (over: Partial<Parameters<typeof emitRemoteOriginatedNotification>[0]> = {}) => ({
  habitatId, eventType: "task.assigned" as const, sourceType: "task" as const,
  targetType: "task" as const, targetId: "task-1", severity: "info" as const,
  title: "t", actorType: "remote_human" as const, actorId: "actor-1", ...over,
});

describe("remote lifecycle → remote_visible (P5)", () => {
  // GROUND: MIGRATION-TASKS T6 6.3 — one authority: the intent's pool
  // population must equal findRemoteRecipientsForEvent on the named target.
  it("pool population equals findRemoteRecipientsForEvent on the named target (one authority)", () => {
    const taskId = seedTaskInHabitat(habitatId);
    const a = seedParticipant("a"); seedGrant(a.podId, a.participantId, taskId);
    const b = seedParticipant("b"); seedGrant(b.podId, b.participantId, taskId);
    emitRemoteOriginatedNotification(baseOpts({ targetId: taskId }));
    const expected = findRemoteRecipientsForEvent({ habitatId, eventType: "task.assigned", targetType: "task", targetId: taskId });
    const event = eventRepo.listNotificationEventsByHabitat(habitatId).events[0]!;
    const got = deliveryRepo.getDeliveriesByEvent(event.id).map((d) => ({ recipientType: d.recipientType, recipientId: d.recipientId }));
    expect(got.sort()).toEqual([...expected].sort());
  });

  // GROUND: MIGRATION-TASKS T6 6.3 — an explicit acting participant inside
  // the pool is kept and deduped against the pool (no double delivery).
  it("explicit acting participant in pool is kept and deduped against the pool", () => {
    const taskId = seedTaskInHabitat(habitatId);
    const a = seedParticipant("a"); seedGrant(a.podId, a.participantId, taskId);
    emitRemoteOriginatedNotification(baseOpts({ targetId: taskId, explicitRecipients: [{ recipientType: "remote_human", recipientId: a.participantId }] }));
    const event = eventRepo.listNotificationEventsByHabitat(habitatId).events[0]!;
    const ids = deliveryRepo.getDeliveriesByEvent(event.id).map((d) => d.recipientId);
    expect(ids.filter((id) => id === a.participantId)).toHaveLength(1);
  });

  // GROUND: MIGRATION-TASKS T6 6.3 — adopted delta: explicit named remote
  // actors are validated against effective grant authority; an ungranted
  // active participant is suppressed (ineligible_remote), never blindly
  // unioned and never a throw. RED on the old blind-union producer.
  it("explicit acting participant with no effective eligible grant is classified suppressed ineligible_remote — adopted delta, no blind union, no throw", () => {
    const taskId = seedTaskInHabitat(habitatId);
    const ungranted = seedParticipant("x");   // active participant, NO grant row: no effective authority for the target
    emitRemoteOriginatedNotification(baseOpts({
      targetId: taskId,
      explicitRecipients: [{ recipientType: "remote_human", recipientId: ungranted.participantId }],
    }));
    const event = eventRepo.listNotificationEventsByHabitat(habitatId).events[0]!;
    expect(deliveryRepo.getDeliveriesByEvent(event.id).map((d) => d.recipientId)).not.toContain(ungranted.participantId);
  });

  // GROUND: MIGRATION-TASKS T6 6.3 — a missing target must not degrade to an
  // untargeted all-grants broadcast: no event row, and exactly one compact
  // webhook dispatch still fires. Replaces the unreachable-today exact/[]
  // branch (all three current callers pass targetType+targetId; the pulse
  // caller's sourceId is the pulse id, NOT the mission id). RED on old.
  it("missing target still dispatches exactly one compact webhook", () => {
    vi.stubEnv("ORCY_PUBLIC_URL", "https://example.test");
    const dispatch = vi.spyOn(compactDispatcher, "dispatchCompactRemoteEvent").mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      emitRemoteOriginatedNotification(baseOpts({ targetType: undefined, targetId: undefined }));
      expect(eventRepo.listNotificationEventsByHabitat(habitatId).events).toHaveLength(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); dispatch.mockRestore(); vi.unstubAllEnvs(); }
  });

  // GROUND: MIGRATION-TASKS T6 6.3 — enqueue failure is best-effort isolated
  // from the separate compact webhook dispatch. RED on the old producer
  // (which never routes through enqueueNotificationWithIntents).
  it("enqueue failure still dispatches exactly one compact webhook", () => {
    vi.stubEnv("ORCY_PUBLIC_URL", "https://example.test");
    const dispatch = vi.spyOn(compactDispatcher, "dispatchCompactRemoteEvent").mockResolvedValue(undefined as never);
    const fail = vi.spyOn(intentCommand, "enqueueNotificationWithIntents").mockImplementation(() => { throw new Error("injected"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitRemoteOriginatedNotification(baseOpts());
      expect(fail).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { error.mockRestore(); fail.mockRestore(); dispatch.mockRestore(); vi.unstubAllEnvs(); }
  });
});
