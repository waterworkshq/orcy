import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { users } from "../db/schema/user.js";
import * as boardRepo from "../repositories/habitat.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import {
  remoteParticipantAuth,
  remoteActionScope,
  isRemoteConnectionValid,
  type RemoteParticipantContext,
} from "../middleware/remoteAuth.js";
import { authenticateRealtime, authorizeHabitatAccess } from "../middleware/realtimeAuth.js";
import { isAppError } from "../errors.js";
import type { RemoteActionScope, ParticipantStanding } from "@orcy/shared/types";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Pod Bridge Auth Test Habitat" });
}

function mockRequest(headers: Record<string, string | undefined> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function mockReply(): FastifyReply {
  return {} as unknown as FastifyReply;
}

async function expectAppError(
  fn: () => Promise<void>,
  statusCode: number,
  codeFragment?: string,
): Promise<void> {
  try {
    await fn();
    throw new Error("Expected middleware to throw but it did not");
  } catch (err) {
    if (!isAppError(err)) throw err;
    if (err.statusCode !== statusCode) {
      throw new Error(
        `Expected status ${statusCode} but got ${err.statusCode}: ${err.message} (${err.code})`,
      );
    }
    if (codeFragment && !err.message.includes(codeFragment) && !err.code?.includes(codeFragment)) {
      throw new Error(
        `Expected error to include '${codeFragment}' but got: ${err.message} (${err.code})`,
      );
    }
  }
}

function setupActiveParticipant(
  habitatId: string,
  standing: ParticipantStanding = "remote_contributor",
  actionScopes?: RemoteActionScope[],
) {
  const pod = podRepo.createRemotePod({ habitatId, name: "Remote Pod" });
  podRepo.activateRemotePod(pod.id);

  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId,
    participantType: "remote_orcy",
    displayName: "Remote Orcy",
    standing,
  });
  participantRepo.activateRemoteParticipant(participant.id);

  const { credential, plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId,
    credentialType: "api",
    label: "test-cred",
  });

  const scopes: RemoteActionScope[] = actionScopes ?? [
    "read",
    "comment",
    "claim",
    "submit",
    "release",
    "heartbeat",
    "evidence_link",
    "pulse.post",
  ];
  const grant = grantRepo.createRemoteGrant({
    habitatId,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing,
    actionScopes: scopes,
  });

  return { pod, participant, credential, plaintextSecret, grant };
}

// ---------------------------------------------------------------------------
// Credential Service
// ---------------------------------------------------------------------------

describe("remoteCredentialService", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("generates a one-time secret with the correct prefix", () => {
    const { plaintextSecret, secretHash } = credentialService.generateRemoteSecret();
    expect(plaintextSecret).toMatch(/^orcy_remote_[0-9a-f-]+-[0-9a-f]+$/);
    expect(plaintextSecret.length).toBeGreaterThan(40);
    expect(secretHash).toHaveLength(64);
    expect(plaintextSecret).not.toBe(secretHash);
  });

  it("hashes a secret deterministically with SHA-256", () => {
    const secret = "orcy_remote_test-12345";
    const hash1 = credentialService.hashRemoteSecret(secret);
    const hash2 = credentialService.hashRemoteSecret(secret);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("creates a credential with a secret and verifies the key", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    podRepo.activateRemotePod(pod.id);
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "RP",
    });
    participantRepo.activateRemoteParticipant(participant.id);

    const { credential, plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: participant.id,
      habitatId: h.id,
      credentialType: "api",
    });

    expect(credential.status).toBe("active");
    expect(plaintextSecret).toMatch(/^orcy_remote_/);

    const verified = credentialService.verifyRemoteKey(plaintextSecret);
    expect(verified).not.toBeNull();
    expect(verified!.credential.id).toBe(credential.id);
  });

  it("returns null for a non-existent key", () => {
    expect(credentialService.verifyRemoteKey("orcy_remote_nonexistent-key-123456")).toBeNull();
  });

  it("returns null for a key without the prefix", () => {
    expect(credentialService.verifyRemoteKey("some-random-key")).toBeNull();
  });

  it("returns null for a rotated credential key", () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const { plaintextSecret: oldSecret } = { plaintextSecret: setup.plaintextSecret };

    const rotation = credentialService.rotateCredential(setup.credential.id, "admin-1");
    expect(rotation.oldCredential?.status).toBe("rotated");
    expect(rotation.newCredential?.status).toBe("active");
    expect(rotation.plaintextSecret).toMatch(/^orcy_remote_/);
    expect(rotation.plaintextSecret).not.toBe(oldSecret);

    expect(credentialService.verifyRemoteKey(oldSecret)).toBeNull();
    expect(credentialService.verifyRemoteKey(rotation.plaintextSecret)).not.toBeNull();
  });

  it("returns null for a revoked credential key", () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    credentialService.revokeCredential(setup.credential.id, "admin-1", "testing");
    expect(credentialService.verifyRemoteKey(setup.plaintextSecret)).toBeNull();
  });

  it("touches last-used timestamp on verify", () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    expect(setup.credential.lastUsedAt).toBeNull();

    credentialService.touchLastUsed(setup.credential.id);

    const updated = credentialService.verifyRemoteKey(setup.plaintextSecret);
    expect(updated!.credential.lastUsedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remoteParticipantAuth middleware
// ---------------------------------------------------------------------------

describe("remoteParticipantAuth middleware", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("throws unauthorized for missing remote key header", async () => {
    await expectAppError(
      () => remoteParticipantAuth(mockRequest(), mockReply()),
      401,
      "MISSING_REMOTE_KEY",
    );
  });

  it("throws unauthorized for invalid remote key", async () => {
    await expectAppError(
      () =>
        remoteParticipantAuth(
          mockRequest({ "x-orcy-remote-key": "orcy_remote_bad-key" }),
          mockReply(),
        ),
      401,
      "INVALID_REMOTE_KEY",
    );
  });

  it("throws forbidden for suspended participant", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    participantRepo.suspendRemoteParticipant(setup.participant.id);

    await expectAppError(
      () =>
        remoteParticipantAuth(
          mockRequest({ "x-orcy-remote-key": setup.plaintextSecret }),
          mockReply(),
        ),
      403,
      "REMOTE_PARTICIPANT_INACTIVE",
    );
  });

  it("throws forbidden for suspended pod", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    podRepo.suspendRemotePod(setup.pod.id);

    await expectAppError(
      () =>
        remoteParticipantAuth(
          mockRequest({ "x-orcy-remote-key": setup.plaintextSecret }),
          mockReply(),
        ),
      403,
      "REMOTE_POD_INACTIVE",
    );
  });

  it("sets request.remoteParticipant with participant, pod, credential, and grants on success", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    expect(req.remoteParticipant).toBeDefined();
    expect(req.remoteParticipant!.participant.id).toBe(setup.participant.id);
    expect(req.remoteParticipant!.pod.id).toBe(setup.pod.id);
    expect(req.remoteParticipant!.credentialId).toBe(setup.credential.id);
    expect(req.remoteParticipant!.habitatId).toBe(h.id);
    expect(req.remoteParticipant!.grants.length).toBeGreaterThanOrEqual(1);
  });

  it("rotated credential old secret fails, new secret succeeds", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    const oldSecret = setup.plaintextSecret;

    const rotation = credentialService.rotateCredential(setup.credential.id, "admin-1");

    await expectAppError(
      () => remoteParticipantAuth(mockRequest({ "x-orcy-remote-key": oldSecret }), mockReply()),
      401,
      "INVALID_REMOTE_KEY",
    );

    const req = mockRequest({ "x-orcy-remote-key": rotation.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());
    expect(req.remoteParticipant).toBeDefined();
    expect(req.remoteParticipant!.credentialId).toBe(rotation.newCredential!.id);
  });
});

// ---------------------------------------------------------------------------
// remoteActionScope middleware
// ---------------------------------------------------------------------------

describe("remoteActionScope middleware", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("throws unauthorized when no remote participant context", async () => {
    const middleware = remoteActionScope("read");
    await expectAppError(() => middleware(mockRequest(), mockReply()), 401, "REMOTE_AUTH_REQUIRED");
  });

  it("allows action within grant scope for matching standing", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_contributor");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const middleware = remoteActionScope("claim");
    await middleware(req, mockReply());
  });

  it("blocks action not in grant scopes", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_observer", ["read", "comment"]);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const middleware = remoteActionScope("claim");
    await expectAppError(() => middleware(req, mockReply()), 403, "ACTION_NOT_IN_GRANT_SCOPES");
  });

  it("blocks claim for remote_observer standing even if scope is granted", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_observer", ["read", "comment", "claim"]);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const middleware = remoteActionScope("claim");
    await expectAppError(() => middleware(req, mockReply()), 403, "STANDING_ACTION_NOT_PERMITTED");
  });

  it("hard revoke blocks all remote actions", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_contributor");
    grantRepo.revokeRemoteGrant(setup.grant.id, "hard", "admin-1", "testing");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const middleware = remoteActionScope("read");
    await expectAppError(() => middleware(req, mockReply()), 403, "GRANT_HARD_REVOKED");
  });

  it("freeze blocks remote actions", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_contributor");
    grantRepo.revokeRemoteGrant(setup.grant.id, "freeze", "admin-1", "testing");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const middleware = remoteActionScope("read");
    await expectAppError(() => middleware(req, mockReply()), 403, "GRANT_FROZEN");
  });

  it("expired grant blocks new claims but allows heartbeat", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_contributor");
    grantRepo.updateRemoteGrantStatus(setup.grant.id, "expired", {
      expiredAt: new Date().toISOString(),
    });

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    await expectAppError(
      () => remoteActionScope("claim")(req, mockReply()),
      403,
      "GRANT_GRACE_ACTION_BLOCKED",
    );

    await remoteActionScope("heartbeat")(req, mockReply());
  });

  it("soft revoked grant allows submit during grace but blocks claim", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_contributor");
    grantRepo.revokeRemoteGrant(setup.grant.id, "soft", "admin-1", "testing");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    await expectAppError(
      () => remoteActionScope("claim")(req, mockReply()),
      403,
      "GRANT_GRACE_ACTION_BLOCKED",
    );

    await remoteActionScope("submit")(req, mockReply());
  });

  it("pod-wide grant (no participantId) applies to all pod participants", async () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    podRepo.activateRemotePod(pod.id);

    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "RP",
      standing: "remote_observer",
    });
    participantRepo.activateRemoteParticipant(participant.id);

    const { plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: participant.id,
      habitatId: h.id,
      credentialType: "api",
    });

    grantRepo.createRemoteGrant({
      habitatId: h.id,
      remotePodId: pod.id,
      remoteParticipantId: null,
      grantType: "baseline_observer",
      standing: "remote_observer",
      actionScopes: ["read", "comment"],
    });

    const req = mockRequest({ "x-orcy-remote-key": plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    expect(req.remoteParticipant!.grants).toHaveLength(1);
    expect(req.remoteParticipant!.grants[0].remoteParticipantId).toBeNull();

    await remoteActionScope("read")(req, mockReply());
    await remoteActionScope("comment")(req, mockReply());
  });

  it("no active grants blocks everything", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    grantRepo.updateRemoteGrantStatus(setup.grant.id, "hard_revoked", {
      revokedAt: new Date().toISOString(),
    });

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    req.remoteParticipant!.grants = [];

    await expectAppError(
      () => remoteActionScope("read")(req, mockReply()),
      403,
      "NO_ACTIVE_GRANTS",
    );
  });

  it("pulse.post is allowed for remote_observer with that scope", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_observer", [
      "read",
      "comment",
      "pulse.post",
    ]);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    await remoteActionScope("pulse.post")(req, mockReply());
  });

  it("evidence_link is allowed for remote_contributor but not remote_observer", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id, "remote_observer", [
      "read",
      "comment",
      "evidence_link",
    ]);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    await expectAppError(
      () => remoteActionScope("evidence_link")(req, mockReply()),
      403,
      "STANDING_ACTION_NOT_PERMITTED",
    );
  });
});

// ---------------------------------------------------------------------------
// Realtime/SSE remote auth
// ---------------------------------------------------------------------------

describe("realtime remote auth", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("authenticateRealtime accepts remote key header", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await authenticateRealtime(req, mockReply());

    expect(req.remoteParticipant).toBeDefined();
    expect(req.remoteParticipant!.participant.id).toBe(setup.participant.id);
  });

  it("authorizeHabitatAccess allows remote participant with valid grant", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    (req as any).params = { id: h.id };
    await authenticateRealtime(req, mockReply());
    await authorizeHabitatAccess(req, mockReply());
  });

  it("authorizeHabitatAccess blocks remote participant for wrong habitat", async () => {
    const h = setupHabitat();
    const h2 = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    (req as any).params = { id: h2.id };
    await authenticateRealtime(req, mockReply());

    await expectAppError(
      () => authorizeHabitatAccess(req, mockReply()),
      403,
      "REMOTE_HABITAT_MISMATCH",
    );
  });

  it("isRemoteConnectionValid returns true for healthy connection", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const result = isRemoteConnectionValid(req.remoteParticipant!);
    expect(result.valid).toBe(true);
  });

  it("isRemoteConnectionValid returns false when credential revoked", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    credentialService.revokeCredential(setup.credential.id, "admin-1", "testing");

    const result = isRemoteConnectionValid(req.remoteParticipant!);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("CREDENTIAL_INVALID");
  });

  it("isRemoteConnectionValid returns false when all grants frozen", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    grantRepo.revokeRemoteGrant(setup.grant.id, "freeze", "admin-1", "testing");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const result = isRemoteConnectionValid(req.remoteParticipant!);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("ALL_GRANTS_BLOCKED");
  });

  it("isRemoteConnectionValid returns false when all grants hard-revoked", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    grantRepo.revokeRemoteGrant(setup.grant.id, "hard", "admin-1", "testing");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const result = isRemoteConnectionValid(req.remoteParticipant!);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("ALL_GRANTS_BLOCKED");
  });

  it("isRemoteConnectionValid returns true during grace (soft revoked)", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);
    grantRepo.revokeRemoteGrant(setup.grant.id, "soft", "admin-1", "testing");

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    const result = isRemoteConnectionValid(req.remoteParticipant!);
    expect(result.valid).toBe(true);
  });

  it("isRemoteConnectionValid returns false when participant suspended", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    await remoteParticipantAuth(req, mockReply());

    participantRepo.suspendRemoteParticipant(setup.participant.id);

    const result = isRemoteConnectionValid(req.remoteParticipant!);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("PARTICIPANT_INACTIVE");
  });

  it("authorizeHabitatAccess blocks revoked credential mid-session", async () => {
    const h = setupHabitat();
    const setup = setupActiveParticipant(h.id);

    const req = mockRequest({ "x-orcy-remote-key": setup.plaintextSecret });
    (req as any).params = { id: h.id };
    await authenticateRealtime(req, mockReply());
    await authorizeHabitatAccess(req, mockReply());

    credentialService.revokeCredential(setup.credential.id, "admin-1", "testing");

    await expectAppError(
      () => authorizeHabitatAccess(req, mockReply()),
      403,
      "REMOTE_CONNECTION_INVALID",
    );
  });
});
