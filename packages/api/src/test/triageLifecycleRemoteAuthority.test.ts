/**
 * In-transaction remote route authority must re-read credential, standing,
 * and grants — not trust the middleware snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import { findingTriage, remoteGrants, tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import { checkRemoteRouteAuthority } from "../services/triageLifecycleAuthority.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";

function seed(): {
  findingId: string;
  taskId: string;
  snapshot: RemoteParticipantContext;
  grantId: string;
} {
  const habitat = habitatRepo.createHabitat({ name: "H" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Admitting",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Investigate",
    description: "x",
    requiredCapabilities: [],
    labels: [],
    createdBy: "user-1",
  });
  const pulse = pulseRepo.createPulse({
    habitatId: habitat.id,
    missionId: mission.id,
    scope: "mission",
    fromType: "human",
    fromId: "user-1",
    signalType: "finding",
    subject: "cluster",
    body: "x",
    metadata: { findingKind: "bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  getDb()
    .update(findingTriage)
    .set({
      admittedByTriageMissionId: mission.id,
      admittedByInvestigationTaskId: task.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, finding.id))
    .run();

  const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId: habitat.id, name: "P" }).id)!;
  const participant = participantRepo.activateRemoteParticipant(
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: habitat.id,
      participantType: "remote_orcy",
      displayName: "RW",
      standing: "remote_contributor",
    }).id,
  )!;
  const { credential } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: habitat.id,
    credentialType: "api",
    label: "test",
  });
  const grant = grantRepo.createRemoteGrant({
    habitatId: habitat.id,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing: "remote_contributor",
    actionScopes: ["read", "comment", "triage.route"] as never,
    eligibilityMode: "allowlist",
  });
  grantRepo.addRemoteGrantTarget(grant.id, "task", task.id);
  getDb()
    .update(tasks)
    .set({ status: "claimed", remoteAssignedParticipantId: participant.id })
    .where(eq(tasks.id, task.id))
    .run();

  const snapshot: RemoteParticipantContext = {
    participant,
    pod,
    credentialId: credential.id,
    habitatId: habitat.id,
    grants: [grantRepo.getRemoteGrantById(grant.id)!],
  };
  return { findingId: finding.id, taskId: task.id, snapshot, grantId: grant.id };
}

function check(snapshot: RemoteParticipantContext, findingId: string, taskId: string, withClient: boolean) {
  return checkRemoteRouteAuthority({
    finding: {
      id: findingId,
      habitatId: snapshot.habitatId,
      admittedByInvestigationTaskId: taskId,
    },
    remote: {
      type: "remote_orcy",
      id: snapshot.participant.id,
      habitatId: snapshot.habitatId,
      remoteParticipant: snapshot,
    },
    client: withClient ? getDb() : undefined,
  });
}

describe("checkRemoteRouteAuthority live re-read", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("allows a live contributor whose snapshot still matches the database", () => {
    const { findingId, taskId, snapshot } = seed();
    expect(check(snapshot, findingId, taskId, true).kind).toBe("allow");
  });

  it("denies when the credential is revoked after the snapshot was built", () => {
    const { findingId, taskId, snapshot } = seed();
    credentialService.revokeCredential(snapshot.credentialId, "test", "revoked for authority proof");
    expect(check(snapshot, findingId, taskId, false).kind).toBe("allow");
    const denied = check(snapshot, findingId, taskId, true);
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.code).toBe("CREDENTIAL_INACTIVE");
  });

  it("denies when standing is demoted after the snapshot was built", () => {
    const { findingId, taskId, snapshot } = seed();
    participantRepo.updateRemoteParticipantStanding(snapshot.participant.id, "remote_observer");
    expect(check(snapshot, findingId, taskId, false).kind).toBe("allow");
    const denied = check(snapshot, findingId, taskId, true);
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.code).toBe("STANDING_NOT_CONTRIBUTOR");
  });

  it("denies an active grant whose expiresAt has already passed", () => {
    const { findingId, taskId, snapshot, grantId } = seed();
    getDb()
      .update(remoteGrants)
      .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(remoteGrants.id, grantId))
      .run();
    const denied = check(snapshot, findingId, taskId, true);
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.code).toBe("NO_SAME_GRANT_WITH_TASK_TARGET");
  });
});
