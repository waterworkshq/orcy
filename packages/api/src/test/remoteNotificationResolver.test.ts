import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import { findRemoteRecipientsForEvent } from "../services/remoteNotificationResolver.js";
import {
  enqueueNotification,
  getResolvedRecipients,
} from "../services/notificationCommandService.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import type { NotificationRecipientType } from "@orcy/shared/types";
import { randomUUID } from "crypto";

const ORIGINAL_ENV = { ...process.env };

function setupHabitat() {
  const habitat = boardRepo.createHabitat({ name: "Phase E Test Habitat" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  return habitat;
}

function setupActivePod(habitatId: string) {
  const pod = podRepo.createRemotePod({ habitatId, name: "Remote Pod" });
  return podRepo.activateRemotePod(pod.id) ?? pod;
}

function setupActiveParticipant(
  habitatId: string,
  podId: string,
  type: "remote_human" | "remote_orcy" = "remote_orcy",
  standing: "remote_observer" | "remote_contributor" | "remote_reviewer" = "remote_contributor",
) {
  const p = participantRepo.createRemoteParticipant({
    remotePodId: podId,
    habitatId,
    participantType: type,
    displayName: `Test ${type}`,
    standing,
  });
  return participantRepo.activateRemoteParticipant(p.id) ?? p;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({
    habitatId,
    title: "Test Mission",
    priority: "medium",
    createdBy: "test",
  });
}

function setupTask(habitatId: string, missionId: string) {
  return taskRepo.createTask({
    missionId,
    title: "Test Task",
    description: "x",
    requiredCapabilities: [],
    labels: [],
    createdBy: "test",
  });
}

describe("Phase E — Remote notification resolver", () => {
  beforeEach(async () => {
    await initTestDb();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    closeDb();
    process.env = ORIGINAL_ENV;
  });

  describe("findRemoteRecipientsForEvent", () => {
    it("returns empty when no grants exist", () => {
      const habitat = setupHabitat();
      const result = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "habitat",
      });
      expect(result).toEqual([]);
    });

    it("returns eligible pod-wide baseline grant participants", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const p1 = setupActiveParticipant(habitat.id, pod.id, "remote_human");
      const p2 = setupActiveParticipant(habitat.id, pod.id, "remote_orcy");
      grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "baseline_observer",
        standing: "remote_observer",
        actionScopes: ["read"],
        // remoteParticipantId: null → pod-wide
      });

      const result = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "habitat",
      });
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.recipientId).sort();
      expect(ids).toEqual([p1.id, p2.id].sort());
    });

    it("returns only the specific participant for per-participant grants", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const p1 = setupActiveParticipant(habitat.id, pod.id, "remote_human");
      const p2 = setupActiveParticipant(habitat.id, pod.id, "remote_orcy");
      grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        remoteParticipantId: p1.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read"],
      });

      const result = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "habitat",
      });
      expect(result).toHaveLength(1);
      expect(result[0].recipientId).toBe(p1.id);
      expect(result[0].recipientType).toBe("remote_human");
    });

    it("filters by target visibility when targetType/targetId are provided", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const p1 = setupActiveParticipant(habitat.id, pod.id, "remote_orcy");
      const mission = setupMission(habitat.id);
      const grant = grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        remoteParticipantId: p1.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read"],
        eligibilityMode: "allowlist",
      });
      grantRepo.addRemoteGrantTarget(grant.id, "mission", mission.id);

      // Visible: target matches
      const visibleResult = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "mission",
        targetId: mission.id,
      });
      expect(visibleResult).toHaveLength(1);
      expect(visibleResult[0].recipientId).toBe(p1.id);

      // Not visible: different target
      const otherMission = setupMission(habitat.id);
      const invisibleResult = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "mission",
        targetId: otherMission.id,
      });
      expect(invisibleResult).toEqual([]);
    });

    it("skips suspended participants in pod-wide grants", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const active = setupActiveParticipant(habitat.id, pod.id, "remote_orcy");
      const suspended = participantRepo.createRemoteParticipant({
        remotePodId: pod.id,
        habitatId: habitat.id,
        participantType: "remote_human",
        displayName: "Suspended",
        standing: "remote_observer",
      });
      const suspendedActive = participantRepo.activateRemoteParticipant(suspended.id);
      participantRepo.suspendRemoteParticipant(suspended.id);
      void suspendedActive; // keep ts happy

      grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "baseline_observer",
        standing: "remote_observer",
        actionScopes: ["read"],
      });

      const result = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "habitat",
      });
      expect(result).toHaveLength(1);
      expect(result[0].recipientId).toBe(active.id);
    });

    it("deduplicates when same participant has multiple eligible grants", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const p = setupActiveParticipant(habitat.id, pod.id, "remote_human");
      grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        remoteParticipantId: p.id,
        grantType: "baseline_observer",
        standing: "remote_observer",
        actionScopes: ["read"],
      });
      grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        remoteParticipantId: p.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read", "comment"],
      });

      const result = findRemoteRecipientsForEvent({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        targetType: "habitat",
      });
      expect(result).toHaveLength(1);
    });
  });

  describe("enqueueNotification integrates with remote resolver", () => {
    it("emits a delivery to the acting remote participant + eligible peers", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const actor = setupActiveParticipant(habitat.id, pod.id, "remote_orcy");
      const peer = setupActiveParticipant(habitat.id, pod.id, "remote_human");
      grantRepo.createRemoteGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "baseline_observer",
        standing: "remote_observer",
        actionScopes: ["read"],
      });
      // Habitat-default subscription so deliveries actually fire
      subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "pulse.signal_posted",
        enabled: true,
        channels: ["in_app"],
        cadence: "immediate",
      });

      const result = enqueueNotification({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        sourceType: "pulse",
        sourceId: randomUUID(),
        targetType: "habitat",
        severity: "info",
        title: "Test pulse",
        createdByType: "remote_orcy",
        createdById: actor.id,
        explicitRecipients: [
          { recipientType: "remote_orcy" as NotificationRecipientType, recipientId: actor.id },
        ],
      });

      // Both the actor and the peer should get deliveries
      const actorDeliveries = deliveryRepo.getActiveInbox(habitat.id, "remote_orcy", actor.id, {
        limit: 10,
      });
      const peerDeliveries = deliveryRepo.getActiveInbox(habitat.id, "remote_human", peer.id, {
        limit: 10,
      });
      expect(actorDeliveries.deliveries).toHaveLength(1);
      expect(peerDeliveries.deliveries).toHaveLength(1);
      expect(result.deliveries).toHaveLength(2);
    });

    it("does not leak deliveries to non-eligible remote participants", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const actor = setupActiveParticipant(habitat.id, pod.id, "remote_orcy");
      subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "pulse.signal_posted",
        enabled: true,
        channels: ["in_app"],
        cadence: "immediate",
      });
      const result = enqueueNotification({
        habitatId: habitat.id,
        eventType: "pulse.signal_posted",
        sourceType: "pulse",
        sourceId: randomUUID(),
        targetType: "habitat",
        severity: "info",
        title: "Test pulse",
        createdByType: "remote_orcy",
        createdById: actor.id,
        explicitRecipients: [
          { recipientType: "remote_orcy" as NotificationRecipientType, recipientId: actor.id },
        ],
      });
      expect(result.deliveries).toHaveLength(1);
    });
  });
});
