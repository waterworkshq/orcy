import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import {
  runWithAuditProvenance,
  setAuditActor,
  setRemoteAuditContext,
  withAuditProvenanceMetadata,
} from "../services/auditProvenanceContext.js";
import * as eventRepo from "../repositories/events/event-crud.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import { queryAuditEvents } from "../services/auditQueryService.js";
import { getCanonicalAuditEvents } from "../services/auditExportService.js";
import { getTaskAuditBundle } from "../services/auditBundleService.js";
import type { ParticipantStanding, RemoteActionScope } from "@orcy/shared/types";

const ORIGINAL_ENV = { ...process.env };

function setupHabitat() {
  const habitat = boardRepo.createHabitat({ name: "Audit Test Habitat" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  return habitat;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({
    habitatId,
    title: "Audit Test Mission",
    priority: "medium",
    createdBy: "test",
  });
}

function setupTask(habitatId: string, missionId: string) {
  return taskRepo.createTask({
    missionId,
    title: "Audit Test Task",
    description: "x",
    requiredCapabilities: [],
    labels: [],
    createdBy: "test",
  });
}

function setupRemoteFixture(habitatId: string) {
  const pod = podRepo.createRemotePod({ habitatId, name: "Remote Pod" });
  podRepo.activateRemotePod(pod.id);
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId,
    participantType: "remote_orcy",
    displayName: "Remote Auditor",
    standing: "remote_contributor" as ParticipantStanding,
  });
  participantRepo.activateRemoteParticipant(participant.id);
  const { credential, plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId,
    credentialType: "api",
    label: "test-cred",
  });
  const grant = grantRepo.createRemoteGrant({
    habitatId,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing: "remote_contributor" as ParticipantStanding,
    actionScopes: ["read", "claim", "submit", "release"] as RemoteActionScope[],
  });
  return { pod, participant, credential, plaintextSecret, grant };
}

describe("Phase E — Remote audit provenance", () => {
  beforeEach(async () => {
    await initTestDb();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    closeDb();
    process.env = ORIGINAL_ENV;
  });

  describe("withAuditProvenanceMetadata — remote context", () => {
    it("injects metadata.audit.remote when remote context is set", () => {
      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", "participant-1");
        setRemoteAuditContext({
          podId: "pod-1",
          participantId: "participant-1",
          standing: "remote_contributor",
          actionKind: "execution",
        });
        const result = withAuditProvenanceMetadata({ reason: "test" });
        expect(result.audit).toBeDefined();
        expect((result.audit as Record<string, unknown>).actorType).toBe("remote_orcy");
        expect((result.audit as Record<string, unknown>).remote).toBeDefined();
        const remote = (result.audit as Record<string, unknown>).remote as Record<string, unknown>;
        expect(remote.podId).toBe("pod-1");
        expect(remote.participantId).toBe("participant-1");
        expect(remote.standing).toBe("remote_contributor");
        expect(remote.actionKind).toBe("execution");
      });
    });

    it("does not inject remote block when no remote context is set", () => {
      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("human", "user-1");
        const result = withAuditProvenanceMetadata({ reason: "test" });
        expect(result.audit).toBeDefined();
        expect((result.audit as Record<string, unknown>).remote).toBeUndefined();
      });
    });
  });

  describe("queryAuditEvents — remote actor filtering", () => {
    it("projects events with remote_orcy actorType", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);

      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", "participant-1");
        setRemoteAuditContext({
          podId: "pod-1",
          participantId: "participant-1",
          standing: "remote_contributor",
          actionKind: "execution",
        });
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: "participant-1",
          action: "claimed",
          fromStatus: "pending",
          toStatus: "claimed",
        });
      });

      const result = queryAuditEvents({ habitatId: habitat.id });
      expect(result.events.length).toBe(1);
      expect(result.events[0].actor.type).toBe("remote_orcy");
      expect(result.events[0].actor.id).toBe("participant-1");
    });

    it("filters by actorType=remote_orcy", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);

      // Remote event
      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", "p-1");
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: "p-1",
          action: "claimed",
        });
      });

      // Local agent event
      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("agent", "agent-1");
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "agent",
          actorId: "agent-1",
          action: "updated",
        });
      });

      const remoteOnly = queryAuditEvents({ habitatId: habitat.id, actorType: "remote_orcy" });
      expect(remoteOnly.events).toHaveLength(1);
      expect(remoteOnly.events[0].actor.type).toBe("remote_orcy");

      const agentOnly = queryAuditEvents({ habitatId: habitat.id, actorType: "agent" });
      expect(agentOnly.events).toHaveLength(1);
      expect(agentOnly.events[0].actor.type).toBe("agent");
    });

    it("includes remote provenance in projection", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);

      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", "p-1");
        setRemoteAuditContext({
          podId: "pod-1",
          participantId: "p-1",
          standing: "remote_contributor",
          actionKind: "execution",
        });
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: "p-1",
          action: "claimed",
        });
      });

      const result = queryAuditEvents({ habitatId: habitat.id });
      expect(result.events[0].provenance.remote).toBeDefined();
      expect(result.events[0].provenance.remote?.podId).toBe("pod-1");
      expect(result.events[0].provenance.remote?.standing).toBe("remote_contributor");
    });
  });

  describe("remote actor name resolution", () => {
    it("resolves displayName from remote_participants table", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);
      const fixture = setupRemoteFixture(habitat.id);

      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", fixture.participant.id);
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: fixture.participant.id,
          action: "claimed",
        });
      });

      const result = queryAuditEvents({ habitatId: habitat.id });
      expect(result.events[0].actor.name).toBe("Remote Auditor");
    });
  });

  describe("audit export — remote actor types", () => {
    it("includes remote_orcy in CSV export", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);
      const fixture = setupRemoteFixture(habitat.id);

      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", fixture.participant.id);
        setRemoteAuditContext({
          podId: fixture.pod.id,
          participantId: fixture.participant.id,
          standing: "remote_contributor",
          actionKind: "execution",
        });
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: fixture.participant.id,
          action: "claimed",
        });
      });

      const csvResult = getCanonicalAuditEvents(habitat.id, {});
      expect(csvResult.events.length).toBe(1);
      expect(csvResult.events[0].actor.type).toBe("remote_orcy");
    });

    it("filters export by actorType=remote_orcy", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);
      const fixture = setupRemoteFixture(habitat.id);

      // Remote event
      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", fixture.participant.id);
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: fixture.participant.id,
          action: "claimed",
        });
      });

      // Local agent event
      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("agent", "agent-1");
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "agent",
          actorId: "agent-1",
          action: "updated",
        });
      });

      const result = getCanonicalAuditEvents(habitat.id, {
        actorType: "remote_orcy",
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].actor.type).toBe("remote_orcy");
    });
  });

  describe("audit bundle — remote events included", () => {
    it("includes remote-attributed events in task audit bundle", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(habitat.id, mission.id);
      const fixture = setupRemoteFixture(habitat.id);

      runWithAuditProvenance({ source: "rest_api" }, () => {
        setAuditActor("remote_orcy", fixture.participant.id);
        setRemoteAuditContext({
          podId: fixture.pod.id,
          participantId: fixture.participant.id,
          standing: "remote_contributor",
          actionKind: "execution",
        });
        eventRepo.createEvent({
          taskId: task.id,
          actorType: "remote_orcy",
          actorId: fixture.participant.id,
          action: "claimed",
          fromStatus: "pending",
          toStatus: "claimed",
        });
      });

      const bundle = getTaskAuditBundle(task.id);
      expect(bundle.events.length).toBe(1);
      expect(bundle.events[0].actor.type).toBe("remote_orcy");
      expect(bundle.events[0].actor.name).toBe("Remote Auditor");
      expect(bundle.events[0].provenance.remote?.podId).toBe(fixture.pod.id);
    });
  });
});
