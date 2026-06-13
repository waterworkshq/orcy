import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { users } from "../db/schema/user.js";
import * as boardRepo from "../repositories/board.js";
import * as providerRepo from "../repositories/identityProvider.js";
import * as externalIdentityRepo from "../repositories/externalIdentity.js";
import * as inviteRepo from "../repositories/remoteInvite.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as credentialRepo from "../repositories/remoteCredential.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as idempotencyRepo from "../repositories/remoteIdempotency.js";
import * as webhookRepo from "../repositories/remoteWebhookEndpoint.js";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Pod Bridge Test Habitat" });
}

const futureDate = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const pastDate = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Identity Providers
// ---------------------------------------------------------------------------

describe("identityProvider repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates and retrieves a provider", () => {
    const h = setupHabitat();
    const provider = providerRepo.createIdentityProvider({
      habitatId: h.id,
      kind: "github",
      name: "GitHub OAuth",
      issuer: "github.com",
      config: { clientId: "abc" },
      enabled: true,
    });
    expect(provider.id).toBeDefined();
    expect(provider.kind).toBe("github");
    expect(provider.enabled).toBe(true);

    const found = providerRepo.getIdentityProviderById(provider.id);
    expect(found?.name).toBe("GitHub OAuth");
    expect(found?.config).toEqual({ clientId: "abc" });
  });

  it("lists providers by habitat and enabled status", () => {
    const h = setupHabitat();
    providerRepo.createIdentityProvider({
      habitatId: h.id,
      kind: "github",
      name: "GH",
      enabled: true,
    });
    providerRepo.createIdentityProvider({
      habitatId: h.id,
      kind: "oidc",
      name: "OIDC",
      enabled: false,
    });

    expect(providerRepo.getIdentityProvidersByHabitat(h.id)).toHaveLength(2);
    expect(providerRepo.getEnabledIdentityProviders(h.id)).toHaveLength(1);
    expect(providerRepo.getEnabledIdentityProviders(h.id)[0].kind).toBe("github");
  });

  it("updates provider config and enabled flag", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "oidc", name: "P" });
    const updated = providerRepo.updateIdentityProvider(p.id, {
      enabled: true,
      config: { issuer: "z" },
    });
    expect(updated?.enabled).toBe(true);
    expect(updated?.config).toEqual({ issuer: "z" });
  });

  it("deletes a provider", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "P" });
    providerRepo.deleteIdentityProvider(p.id);
    expect(providerRepo.getIdentityProviderById(p.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth States
// ---------------------------------------------------------------------------

describe("identityProviderAuthState repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates, finds by state token, and consumes", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "GH" });
    const state = providerRepo.createAuthState({
      providerId: p.id,
      habitatId: h.id,
      state: "random-state-123",
      nonce: "nonce-abc",
      pkceVerifier: "verifier-xyz",
      inviteId: "invite-1",
      expiresAt: futureDate(1),
    });
    expect(state.status).toBe("pending");

    const found = providerRepo.getAuthStateByState("random-state-123");
    expect(found?.providerId).toBe(p.id);
    expect(found?.inviteId).toBe("invite-1");

    const consumed = providerRepo.consumeAuthState(state.id);
    expect(consumed?.status).toBe("consumed");
    expect(consumed?.consumedAt).not.toBeNull();
  });

  it("enforces unique state token", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "GH" });
    providerRepo.createAuthState({
      providerId: p.id,
      habitatId: h.id,
      state: "dup-state",
      expiresAt: futureDate(1),
    });
    expect(() =>
      providerRepo.createAuthState({
        providerId: p.id,
        habitatId: h.id,
        state: "dup-state",
        expiresAt: futureDate(1),
      }),
    ).toThrow();
  });

  it("deletes expired pending auth states", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "GH" });
    providerRepo.createAuthState({
      providerId: p.id,
      habitatId: h.id,
      state: "expired-state",
      expiresAt: pastDate(1),
    });
    providerRepo.createAuthState({
      providerId: p.id,
      habitatId: h.id,
      state: "active-state",
      expiresAt: futureDate(1),
    });

    const deleted = providerRepo.deleteExpiredAuthStates();
    expect(deleted).toBe(1);
    expect(providerRepo.getAuthStateByState("expired-state")).toBeNull();
    expect(providerRepo.getAuthStateByState("active-state")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// External Identities
// ---------------------------------------------------------------------------

describe("externalIdentity repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates and retrieves by provider+subject", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "GH" });
    const ext = externalIdentityRepo.createExternalIdentity({
      providerId: p.id,
      habitatId: h.id,
      externalSubject: "github-user-42",
      accountLogin: "octocat",
      email: "octo@cat.com",
    });
    expect(ext.id).toBeDefined();

    const found = externalIdentityRepo.getExternalIdentityByProviderSubject(p.id, "github-user-42");
    expect(found?.accountLogin).toBe("octocat");
  });

  it("enforces unique provider+subject", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "GH" });
    externalIdentityRepo.createExternalIdentity({
      providerId: p.id,
      habitatId: h.id,
      externalSubject: "dup-subject",
    });
    expect(() =>
      externalIdentityRepo.createExternalIdentity({
        providerId: p.id,
        habitatId: h.id,
        externalSubject: "dup-subject",
      }),
    ).toThrow();
  });

  it("links to local user and remote participant", () => {
    const h = setupHabitat();
    const p = providerRepo.createIdentityProvider({ habitatId: h.id, kind: "github", name: "GH" });
    const ext = externalIdentityRepo.createExternalIdentity({
      providerId: p.id,
      habitatId: h.id,
      externalSubject: "user-99",
    });

    const db = getDb();
    db.insert(users)
      .values({
        id: "local-user-1",
        username: "local-user-1",
        passwordHash: "hash",
        displayName: "Local",
      })
      .run();

    const linked = externalIdentityRepo.linkExternalIdentityToLocalUser(ext.id, "local-user-1");
    expect(linked?.localUserId).toBe("local-user-1");

    const linked2 = externalIdentityRepo.linkExternalIdentityToRemoteParticipant(ext.id, "rp-1");
    expect(linked2?.remoteParticipantId).toBe("rp-1");
  });
});

// ---------------------------------------------------------------------------
// Remote Invites
// ---------------------------------------------------------------------------

describe("remoteInvite repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates, accepts, and revokes invites", () => {
    const h = setupHabitat();
    const invite = inviteRepo.createRemoteInvite({
      habitatId: h.id,
      inviteType: "manual",
      baselineStanding: "remote_observer",
      baselineScopes: ["read", "comment"],
      tokenHash: "hash-abc",
      invitedBy: "admin-1",
    });
    expect(invite.status).toBe("pending");

    const byToken = inviteRepo.getRemoteInviteByTokenHash("hash-abc");
    expect(byToken?.id).toBe(invite.id);

    const accepted = inviteRepo.acceptRemoteInvite(invite.id, "remote-admin-1");
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.acceptedBy).toBe("remote-admin-1");
  });

  it("revokes an invite with reason", () => {
    const h = setupHabitat();
    const invite = inviteRepo.createRemoteInvite({
      habitatId: h.id,
      inviteType: "manual",
      baselineStanding: "remote_observer",
      tokenHash: "h",
      invitedBy: "admin-1",
    });
    const revoked = inviteRepo.revokeRemoteInvite(invite.id, "admin-1", "policy violation");
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokeReason).toBe("policy violation");
  });

  it("expires pending invites past their expiry", () => {
    const h = setupHabitat();
    inviteRepo.createRemoteInvite({
      habitatId: h.id,
      inviteType: "manual",
      baselineStanding: "remote_observer",
      tokenHash: "expired",
      invitedBy: "admin-1",
      expiresAt: pastDate(2),
    });
    inviteRepo.createRemoteInvite({
      habitatId: h.id,
      inviteType: "manual",
      baselineStanding: "remote_observer",
      tokenHash: "active",
      invitedBy: "admin-1",
      expiresAt: futureDate(2),
    });

    const count = inviteRepo.expirePendingInvites();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Remote Pods
// ---------------------------------------------------------------------------

describe("remotePod repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates, activates, suspends, and revokes", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({
      habitatId: h.id,
      name: "Partner Pod",
      defaultStanding: "remote_observer",
    });
    expect(pod.status).toBe("pending");

    const active = podRepo.activateRemotePod(pod.id);
    expect(active?.status).toBe("active");

    const suspended = podRepo.suspendRemotePod(pod.id);
    expect(suspended?.status).toBe("suspended");

    const revoked = podRepo.revokeRemotePod(pod.id, "admin-1", "trust broken");
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokeReason).toBe("trust broken");
  });

  it("filters pods by habitat and status", () => {
    const h = setupHabitat();
    const p1 = podRepo.createRemotePod({ habitatId: h.id, name: "A" });
    podRepo.createRemotePod({ habitatId: h.id, name: "B" });
    podRepo.activateRemotePod(p1.id);

    expect(podRepo.getRemotePodsByHabitat(h.id)).toHaveLength(2);
    expect(podRepo.getRemotePodsByHabitat(h.id, "active")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Remote Participants
// ---------------------------------------------------------------------------

describe("remoteParticipant repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates with proposed capabilities and updates host-approved", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "Remote Orcy 1",
      standing: "remote_observer",
      proposedCapabilities: ["backend", "testing"],
      proposedDomains: ["api", "mcp"],
    });

    expect(participant.proposedCapabilities).toEqual(["backend", "testing"]);
    expect(participant.approvedCapabilities).toEqual([]);

    const approved = participantRepo.updateHostApprovedCapabilities(
      participant.id,
      ["backend"],
      ["api"],
    );
    expect(approved?.approvedCapabilities).toEqual(["backend"]);
    expect(approved?.approvedDomains).toEqual(["api"]);
  });

  it("activates, suspends, and revokes", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const p = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_human",
      displayName: "Admin",
    });

    expect(participantRepo.activateRemoteParticipant(p.id)?.status).toBe("active");
    expect(participantRepo.suspendRemoteParticipant(p.id)?.status).toBe("suspended");
    expect(participantRepo.revokeRemoteParticipant(p.id)?.status).toBe("revoked");
  });

  it("lists participants by pod and habitat", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "A",
    });
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_human",
      displayName: "B",
    });

    expect(participantRepo.getRemoteParticipantsByPod(pod.id)).toHaveLength(2);
    expect(participantRepo.getRemoteParticipantsByHabitat(h.id)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Remote Credentials
// ---------------------------------------------------------------------------

describe("remoteCredential repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates, finds by hash, and touches last-used", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "Orcy",
    });
    const cred = credentialRepo.createRemoteCredential({
      remoteParticipantId: participant.id,
      habitatId: h.id,
      credentialType: "mcp",
      secretHash: "secret-hash-123",
    });
    expect(cred.status).toBe("active");

    const byHash = credentialRepo.getRemoteCredentialByHash("secret-hash-123");
    expect(byHash?.id).toBe(cred.id);

    credentialRepo.touchCredentialLastUsed(cred.id);
    const touched = credentialRepo.getRemoteCredentialById(cred.id);
    expect(touched?.lastUsedAt).not.toBeNull();
  });

  it("rotates credential preserving identity and grants", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "Orcy",
    });
    const old = credentialRepo.createRemoteCredential({
      remoteParticipantId: participant.id,
      habitatId: h.id,
      credentialType: "api",
      secretHash: "old-hash",
    });

    const { oldCredential, newCredential } = credentialRepo.rotateRemoteCredential(
      old.id,
      "new-hash",
      "admin-1",
    );
    expect(oldCredential?.status).toBe("rotated");
    expect(newCredential?.status).toBe("active");
    expect(newCredential?.secretHash).toBe("new-hash");
    expect(newCredential?.remoteParticipantId).toBe(participant.id);
    expect(newCredential?.rotatedFromId).toBe(old.id);
  });

  it("revokes and expires credentials", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: h.id,
      participantType: "remote_orcy",
      displayName: "Orcy",
    });
    const cred = credentialRepo.createRemoteCredential({
      remoteParticipantId: participant.id,
      habitatId: h.id,
      credentialType: "mcp",
      secretHash: "revoke-me",
      expiresAt: pastDate(1),
    });

    const expired = credentialRepo.expireCredentials();
    expect(expired).toBe(1);
    expect(credentialRepo.getRemoteCredentialById(cred.id)?.status).toBe("expired");

    const cred2 = credentialRepo.createRemoteCredential({
      remoteParticipantId: participant.id,
      habitatId: h.id,
      credentialType: "mcp",
      secretHash: "revoke-me-2",
    });
    const revoked = credentialRepo.revokeRemoteCredential(cred2.id, "admin", "compromised");
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokeReason).toBe("compromised");
  });
});

// ---------------------------------------------------------------------------
// Remote Grants
// ---------------------------------------------------------------------------

describe("remoteGrant repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  function setupGrant(habitatId: string) {
    const pod = podRepo.createRemotePod({ habitatId, name: "P" });
    const grant = grantRepo.createRemoteGrant({
      habitatId,
      remotePodId: pod.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["claim", "submit", "comment"],
      graceWindowHours: 12,
      expiresAt: futureDate(48),
    });
    return { pod, grant };
  }

  it("creates and retrieves active grants", () => {
    const h = setupHabitat();
    const { pod, grant } = setupGrant(h.id);
    expect(grant.status).toBe("active");
    expect(grant.actionScopes).toEqual(["claim", "submit", "comment"]);
    expect(grant.graceWindowHours).toBe(12);

    const byHabitat = grantRepo.getActiveGrantsByHabitat(h.id);
    expect(byHabitat).toHaveLength(1);

    const byPod = grantRepo.getActiveGrantsByPod(pod.id);
    expect(byPod).toHaveLength(1);
  });

  it("revokes with soft/hard/freeze modes", () => {
    const h = setupHabitat();
    const { grant: g1 } = setupGrant(h.id);
    const soft = grantRepo.revokeRemoteGrant(g1.id, "soft", "admin-1");
    expect(soft?.status).toBe("soft_revoked");
    expect(soft?.revocationMode).toBe("soft");

    const { grant: g2 } = setupGrant(h.id);
    const hard = grantRepo.revokeRemoteGrant(g2.id, "hard", "admin-1", "compromised");
    expect(hard?.status).toBe("hard_revoked");

    const { grant: g3 } = setupGrant(h.id);
    const frozen = grantRepo.revokeRemoteGrant(g3.id, "freeze", "admin-1");
    expect(frozen?.status).toBe("frozen");
  });

  it("expires active grants past their expiry", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    grantRepo.createRemoteGrant({
      habitatId: h.id,
      remotePodId: pod.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      expiresAt: pastDate(1),
    });
    grantRepo.createRemoteGrant({
      habitatId: h.id,
      remotePodId: pod.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      expiresAt: futureDate(1),
    });

    const count = grantRepo.expireActiveGrants();
    expect(count).toBe(1);
  });
});

describe("remoteGrantTarget repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("adds, lists, and removes targets", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const grant = grantRepo.createRemoteGrant({
      habitatId: h.id,
      remotePodId: pod.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
    });

    grantRepo.addRemoteGrantTarget(grant.id, "mission", "mission-1");
    grantRepo.addRemoteGrantTarget(grant.id, "task", "task-1");

    expect(grantRepo.getRemoteGrantTargets(grant.id)).toHaveLength(2);

    grantRepo.removeRemoteGrantTarget(grant.id, "task-1");
    expect(grantRepo.getRemoteGrantTargets(grant.id)).toHaveLength(1);
  });
});

describe("remoteGrantRule repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates and updates rule for a grant (one-to-one)", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const grant = grantRepo.createRemoteGrant({
      habitatId: h.id,
      remotePodId: pod.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      eligibilityMode: "rule_based",
    });

    const rule1 = grantRepo.setRemoteGrantRule(grant.id, {
      domains: ["backend"],
      labels: ["urgent"],
    });
    expect(rule1.domains).toEqual(["backend"]);

    const rule2 = grantRepo.setRemoteGrantRule(grant.id, {
      domains: ["backend", "frontend"],
      capabilities: ["testing"],
    });
    expect(rule2.domains).toEqual(["backend", "frontend"]);
    expect(rule2.capabilities).toEqual(["testing"]);
    expect(grantRepo.getRemoteGrantRule(grant.id)?.id).toBe(rule1.id);
  });
});

describe("remoteGrantTaskSnapshot repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("snapshots tasks and checks membership", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const grant = grantRepo.createRemoteGrant({
      habitatId: h.id,
      remotePodId: pod.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      eligibilityMode: "rule_based",
    });

    grantRepo.addGrantTaskSnapshot(grant.id, "task-1", "domain:backend");
    grantRepo.addGrantTaskSnapshot(grant.id, "task-2", "label:urgent");

    expect(grantRepo.getGrantTaskSnapshots(grant.id)).toHaveLength(2);
    expect(grantRepo.isTaskInGrantSnapshot(grant.id, "task-1")).toBe(true);
    expect(grantRepo.isTaskInGrantSnapshot(grant.id, "task-3")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Remote Idempotency Keys
// ---------------------------------------------------------------------------

describe("remoteIdempotencyKey repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates new key and deduplicates on replay", () => {
    const h = setupHabitat();
    const first = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: h.id,
      remoteParticipantId: "rp-1",
      action: "claim",
      idempotencyKey: "client-key-1",
      requestHash: "hash-aaa",
      expiresAt: futureDate(24),
    });
    expect(first.created).toBe(true);
    expect(first.row.status).toBe("pending");

    const second = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: h.id,
      remoteParticipantId: "rp-1",
      action: "claim",
      idempotencyKey: "client-key-1",
      requestHash: "hash-aaa",
      expiresAt: futureDate(24),
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });

  it("completes and fails idempotency keys", () => {
    const h = setupHabitat();
    const { row } = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: h.id,
      remoteParticipantId: "rp-1",
      action: "submit",
      idempotencyKey: "key-2",
      requestHash: "hash-bbb",
      expiresAt: futureDate(24),
    });

    const completed = idempotencyRepo.completeIdempotencyKey(row.id, 200, { ok: true });
    expect(completed?.status).toBe("completed");
    expect(completed?.responseStatus).toBe(200);
    expect(completed?.responseBody).toEqual({ ok: true });

    const { row: row2 } = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: h.id,
      remoteParticipantId: "rp-1",
      action: "release",
      idempotencyKey: "key-3",
      requestHash: "hash-ccc",
      expiresAt: futureDate(24),
    });
    const failed = idempotencyRepo.failIdempotencyKey(row2.id, "validation error", 400);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("validation error");
  });

  it("deletes expired keys", () => {
    const h = setupHabitat();
    idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: h.id,
      remoteParticipantId: "rp-1",
      action: "claim",
      idempotencyKey: "expired-key",
      requestHash: "h",
      expiresAt: pastDate(1),
    });
    idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: h.id,
      remoteParticipantId: "rp-1",
      action: "claim",
      idempotencyKey: "active-key",
      requestHash: "h2",
      expiresAt: futureDate(1),
    });

    const deleted = idempotencyRepo.deleteExpiredIdempotencyKeys();
    expect(deleted).toBe(1);
    expect(idempotencyRepo.getIdempotencyKey("rp-1", "claim", "active-key")).not.toBeNull();
    expect(idempotencyRepo.getIdempotencyKey("rp-1", "claim", "expired-key")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Remote Webhook Endpoints
// ---------------------------------------------------------------------------

describe("remoteWebhookEndpoint repository", () => {
  beforeEach(async () => await initTestDb());
  afterEach(() => closeDb());

  it("creates pending endpoint and transitions through approve → enable → disable", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const endpoint = webhookRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: h.id,
      url: "https://partner-pod.example.com/webhook",
      events: ["task.claimed", "task.submitted"],
    });
    expect(endpoint.status).toBe("pending");

    const approved = webhookRepo.approveRemoteWebhookEndpoint(endpoint.id, "admin-1");
    expect(approved?.status).toBe("approved");

    const enabled = webhookRepo.enableRemoteWebhookEndpoint(endpoint.id, "admin-1");
    expect(enabled?.status).toBe("enabled");

    expect(webhookRepo.getEnabledWebhookEndpoints(h.id)).toHaveLength(1);

    const disabled = webhookRepo.disableRemoteWebhookEndpoint(endpoint.id);
    expect(disabled?.status).toBe("disabled");
  });

  it("rejects an endpoint", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const endpoint = webhookRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: h.id,
      url: "https://bad.example.com/hook",
    });
    const rejected = webhookRepo.rejectRemoteWebhookEndpoint(
      endpoint.id,
      "admin-1",
      "untrusted domain",
    );
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.rejectReason).toBe("untrusted domain");
  });

  it("updates last test result", () => {
    const h = setupHabitat();
    const pod = podRepo.createRemotePod({ habitatId: h.id, name: "P" });
    const endpoint = webhookRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: h.id,
      url: "https://partner.example.com/hook",
    });
    const tested = webhookRepo.updateWebhookTestResult(endpoint.id, "ok");
    expect(tested?.lastTestStatus).toBe("ok");
    expect(tested?.lastTestAt).not.toBeNull();
  });
});
