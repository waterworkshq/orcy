import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { remoteAccessRoutes } from "../routes/remoteAccess.js";
import { sharedInviteRoutes } from "../routes/sharedInvite.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as boardRepo from "../repositories/board.js";
import * as readinessService from "../services/shareHabitatReadinessService.js";
import * as providerService from "../services/identityProviderService.js";
import * as inviteService from "../services/remoteInviteService.js";
import * as adminService from "../services/remoteAccessAdminService.js";
import * as mcpConfigService from "../services/mcpConfigService.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialRepo from "../repositories/remoteCredential.js";
import { isAppError } from "../errors.js";

const JWT_SECRET = "dev-secret-change-in-production";
const ORIGINAL_ENV = { ...process.env };

function makeAdminToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

function makeViewerToken(): string {
  return jwt.sign({ sub: "viewer-1", username: "viewer", role: "viewer" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(remoteAccessRoutes);
      await f.register(sharedInviteRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Phase C Test Habitat" });
}

function setupActivePod(habitatId: string) {
  const pod = podRepo.createRemotePod({ habitatId, name: "Remote Pod" });
  return podRepo.activateRemotePod(pod.id) ?? pod;
}

function setupActiveParticipant(habitatId: string, podId: string) {
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: podId,
    habitatId,
    participantType: "remote_orcy",
    displayName: "Remote Worker",
    standing: "remote_contributor",
  });
  return participantRepo.activateRemoteParticipant(participant.id) ?? participant;
}

describe("Phase C — Share Habitat Admin Surface", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    process.env = { ...ORIGINAL_ENV };
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    process.env = ORIGINAL_ENV;
  });

  // -------------------------------------------------------------------------
  // Readiness Checks
  // -------------------------------------------------------------------------

  describe("Readiness Checks", () => {
    it("returns not ready when ORCY_PUBLIC_URL is not set", () => {
      delete process.env.ORCY_PUBLIC_URL;
      delete process.env.ORCY_BASE_URL;
      const habitat = setupHabitat();
      const report = readinessService.checkReadiness(habitat.id);
      expect(report.ready).toBe(false);
      expect(report.canInvite).toBe(false);
      expect(report.baseUrl).toBeNull();
      const baseUrlCheck = report.checks.find((c) => c.key === "base_url");
      expect(baseUrlCheck?.passed).toBe(false);
    });

    it("returns ready with HTTPS URL and provider configured", () => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
      const habitat = setupHabitat();
      providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        enabled: true,
        callbackUrl: "https://orcy.example.com/api/shared/auth/callback",
      });
      const report = readinessService.checkReadiness(habitat.id);
      expect(report.ready).toBe(true);
      expect(report.canInvite).toBe(true);
      expect(report.profile).toBe("tunnel");
      expect(report.hasProvider).toBe(true);
    });

    it("returns ready with private network and manual invite fallback", () => {
      process.env.ORCY_PUBLIC_URL = "http://192.168.1.100:3000";
      const habitat = setupHabitat();
      const report = readinessService.checkReadiness(habitat.id, {
        manualInviteSelected: true,
      });
      expect(report.ready).toBe(true);
      expect(report.canInvite).toBe(true);
      expect(report.profile).toBe("lan_vpn_tailscale");
      expect(report.hasManualInviteOption).toBe(true);
    });

    it("warns when manual invite is selected without provider", () => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
      const habitat = setupHabitat();
      const report = readinessService.checkReadiness(habitat.id, {
        manualInviteSelected: true,
      });
      expect(report.ready).toBe(true);
      const warning = report.checks.find((c) => c.key === "manual_invite_warning");
      expect(warning?.severity).toBe("warning");
      expect(warning?.passed).toBe(false);
    });

    it("fails when provider callback URL does not match base URL", () => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
      const habitat = setupHabitat();
      providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        enabled: true,
        callbackUrl: "https://wrong-url.com/callback",
      });
      const report = readinessService.checkReadiness(habitat.id);
      const callbackCheck = report.checks.find((c) => c.key === "callback_url_match");
      expect(callbackCheck?.passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Identity Provider Configuration
  // -------------------------------------------------------------------------

  describe("Identity Provider Configuration", () => {
    it("creates a GitHub OAuth provider with default scopes", () => {
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub OAuth",
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
        enabled: true,
      });
      expect(provider.kind).toBe("github");
      expect(provider.enabled).toBe(true);
      expect(provider.hasClientSecret).toBe(true);
      expect(provider.scopes).toEqual(["read:user", "user:email"]);
    });

    it("creates an OIDC provider with custom scopes", () => {
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "oidc",
        name: "Keycloak",
        issuer: "https://keycloak.example.com/realms/orcy",
        clientId: "oidc-client",
        clientSecret: "oidc-secret",
        scopes: ["openid", "profile", "email", "groups"],
        enabled: true,
      });
      expect(provider.kind).toBe("oidc");
      expect(provider.issuer).toBe("https://keycloak.example.com/realms/orcy");
      expect(provider.scopes).toContain("groups");
    });

    it("updates provider enabled state", () => {
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        enabled: false,
      });
      expect(provider.enabled).toBe(false);
      const updated = providerService.updateProvider(habitat.id, provider.id, { enabled: true });
      expect(updated.enabled).toBe(true);
    });

    it("deletes a provider", () => {
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub",
        clientId: "gh-client",
        clientSecret: "gh-secret",
      });
      providerService.deleteProvider(habitat.id, provider.id);
      expect(providerService.listProviders(habitat.id)).toHaveLength(0);
    });

    it("initiates auth state with PKCE for OIDC", () => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "oidc",
        name: "Keycloak",
        issuer: "https://keycloak.example.com/realms/orcy",
        clientId: "oidc-client",
        clientSecret: "oidc-secret",
        enabled: true,
      });
      const result = providerService.initiateAuthState(habitat.id, provider.id);
      expect(result.state).toBeTruthy();
      expect(result.nonce).toBeTruthy();
      expect(result.pkceVerifier).toBeTruthy();
      expect(result.pkceChallenge).toBeTruthy();
      expect(result.authUrl).toContain("code_challenge_method=S256");
      expect(result.authUrl).toContain("https://keycloak.example.com/realms/orcy/authorize");
    });

    it("rejects auth state initiation for disabled provider", () => {
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        enabled: false,
      });
      expect(() => providerService.initiateAuthState(habitat.id, provider.id)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Invite Lifecycle
  // -------------------------------------------------------------------------

  describe("Invite Lifecycle", () => {
    it("creates manual invite with one-time token", () => {
      const habitat = setupHabitat();
      const { invite, oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_observer",
        baselineScopes: ["read", "comment"],
        invitedBy: "admin-1",
      });
      expect(invite.inviteType).toBe("manual");
      expect(invite.status).toBe("pending");
      expect(invite.baselineStanding).toBe("remote_observer");
      expect(oneTimeToken).toMatch(/^orcy_invite_/);
    });

    it("creates provider invite without token", () => {
      const habitat = setupHabitat();
      const provider = providerService.configureProvider({
        habitatId: habitat.id,
        kind: "github",
        name: "GitHub",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        enabled: true,
      });
      const invite = inviteService.createProviderInvite({
        habitatId: habitat.id,
        providerId: provider.id,
        baselineStanding: "remote_contributor",
        baselineScopes: ["read", "comment", "claim"],
        invitedBy: "admin-1",
      });
      expect(invite.inviteType).toBe("provider");
      expect(invite.providerId).toBe(provider.id);
      expect(invite.status).toBe("pending");
    });

    it("accepts manual invite and creates pod + participant", () => {
      const habitat = setupHabitat();
      const { oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_contributor",
        invitedBy: "admin-1",
      });
      const result = inviteService.acceptManualInvite(oneTimeToken, "remote-admin", {
        podName: "External Pod",
        participantDisplayName: "Remote Admin",
      });
      expect(result.invite.status).toBe("accepted");
      expect(result.remotePod.status).toBe("active");
      expect(result.remotePod.name).toBe("External Pod");
      expect(result.remoteParticipant.displayName).toBe("Remote Admin");
      expect(result.remoteParticipant.standing).toBe("remote_contributor");
    });

    it("rejects already-accepted manual invite", () => {
      const habitat = setupHabitat();
      const { oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_observer",
        invitedBy: "admin-1",
      });
      inviteService.acceptManualInvite(oneTimeToken, "remote-admin", {
        podName: "Pod 1",
        participantDisplayName: "Admin",
      });
      expect(() =>
        inviteService.acceptManualInvite(oneTimeToken, "other-admin", {
          podName: "Pod 2",
          participantDisplayName: "Admin 2",
        }),
      ).toThrow();
    });

    it("rejects revoked manual invite", () => {
      const habitat = setupHabitat();
      const { invite, oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_observer",
        invitedBy: "admin-1",
      });
      inviteService.revokeInvite(habitat.id, invite.id, "admin-1", "Changed mind");
      expect(() =>
        inviteService.acceptManualInvite(oneTimeToken, "remote-admin", {
          podName: "Pod",
          participantDisplayName: "Admin",
        }),
      ).toThrow();
    });

    it("rejects invalid token format", () => {
      expect(() =>
        inviteService.acceptManualInvite("invalid-token", "admin", {
          podName: "Pod",
          participantDisplayName: "Admin",
        }),
      ).toThrow();
    });

    it("cannot revoke already-accepted invite", () => {
      const habitat = setupHabitat();
      const { invite, oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_observer",
        invitedBy: "admin-1",
      });
      inviteService.acceptManualInvite(oneTimeToken, "remote-admin", {
        podName: "Pod",
        participantDisplayName: "Admin",
      });
      expect(() => inviteService.revokeInvite(habitat.id, invite.id, "admin-1")).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Remote Pod Management
  // -------------------------------------------------------------------------

  describe("Remote Pod Management", () => {
    it("lists pods for habitat", () => {
      const habitat = setupHabitat();
      setupActivePod(habitat.id);
      setupActivePod(habitat.id);
      const pods = adminService.listPods(habitat.id);
      expect(pods).toHaveLength(2);
    });

    it("gets pod details with participant and grant counts", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      setupActiveParticipant(habitat.id, pod.id);
      const view = adminService.getPod(habitat.id, pod.id);
      expect(view.participantCount).toBe(1);
      expect(view.activeGrantCount).toBe(0);
    });

    it("suspends and reactivates pod", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const suspended = adminService.suspendPod(habitat.id, pod.id);
      expect(suspended.status).toBe("suspended");
      const reactivated = adminService.activatePod(habitat.id, pod.id);
      expect(reactivated.status).toBe("active");
    });

    it("cannot activate revoked pod", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      adminService.revokePod(habitat.id, pod.id, "admin-1", "trust issue");
      expect(() => adminService.activatePod(habitat.id, pod.id)).toThrow();
    });

    it("updates pod metadata", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const updated = adminService.updatePod(habitat.id, pod.id, {
        name: "Updated Pod Name",
        description: "Updated description",
      });
      expect(updated.name).toBe("Updated Pod Name");
      expect(updated.description).toBe("Updated description");
    });
  });

  // -------------------------------------------------------------------------
  // Remote Participant Management
  // -------------------------------------------------------------------------

  describe("Remote Participant Management", () => {
    it("approves participant with host-approved capabilities", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const approved = adminService.approveParticipant(habitat.id, participant.id, {
        approvedCapabilities: ["backend", "testing"],
        approvedDomains: ["api", "infra"],
      });

      expect(approved.approvedCapabilities).toEqual(["backend", "testing"]);
      expect(approved.approvedDomains).toEqual(["api", "infra"]);
    });

    it("updates participant standing", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const updated = adminService.approveParticipant(habitat.id, participant.id, {
        standing: "remote_observer",
      });

      expect(updated.standing).toBe("remote_observer");
    });

    it("suspends and revokes participant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const suspended = adminService.suspendParticipant(habitat.id, participant.id);
      expect(suspended.status).toBe("suspended");
      expect(suspended.suspendedAt).toBeTruthy();

      const revoked = adminService.revokeParticipant(habitat.id, participant.id);
      expect(revoked.status).toBe("revoked");
      expect(revoked.revokedAt).toBeTruthy();
    });

    it("lists participants filtered by pod", () => {
      const habitat = setupHabitat();
      const pod1 = setupActivePod(habitat.id);
      const pod2 = setupActivePod(habitat.id);
      setupActiveParticipant(habitat.id, pod1.id);
      setupActiveParticipant(habitat.id, pod1.id);
      setupActiveParticipant(habitat.id, pod2.id);

      const pod1Participants = adminService.listParticipants(habitat.id, { podId: pod1.id });
      expect(pod1Participants).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Grant Management
  // -------------------------------------------------------------------------

  describe("Grant Management", () => {
    it("creates allowlist grant with targets", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        remoteParticipantId: participant.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read", "claim", "submit"],
        targets: [{ targetType: "habitat", targetId: habitat.id }],
        createdBy: "admin-1",
      });

      expect(grant.grantType).toBe("scoped_elevation");
      expect(grant.status).toBe("active");
      expect(grant.isPodWide).toBe(false);
      expect(grant.targets).toHaveLength(1);
    });

    it("creates pod-wide grant when participantId omitted", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "baseline_observer",
        standing: "remote_observer",
        actionScopes: ["read", "comment"],
        createdBy: "admin-1",
      });

      expect(grant.isPodWide).toBe(true);
      expect(grant.remoteParticipantId).toBeNull();
    });

    it("creates rule-based grant with rule", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read", "claim"],
        eligibilityMode: "rule_based",
        rule: {
          domains: ["backend"],
          capabilities: ["node"],
        },
        createdBy: "admin-1",
      });

      expect(grant.eligibilityMode).toBe("rule_based");
      expect(grant.rule).not.toBeNull();
      expect(grant.rule?.domains).toEqual(["backend"]);
    });

    it("rejects permanent execution grant without submit scope", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      expect(() =>
        adminService.createGrant({
          habitatId: habitat.id,
          remotePodId: pod.id,
          grantType: "permanent_execution",
          standing: "remote_contributor",
          actionScopes: ["read"],
          createdBy: "admin-1",
        }),
      ).toThrow();
    });

    it("soft revokes a grant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read"],
        createdBy: "admin-1",
      });

      const revoked = adminService.revokeGrant(habitat.id, grant.id, "soft", "admin-1");
      expect(revoked.status).toBe("soft_revoked");
      expect(revoked.revocationMode).toBe("soft");
    });

    it("hard revokes a grant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read"],
        createdBy: "admin-1",
      });

      const revoked = adminService.revokeGrant(
        habitat.id,
        grant.id,
        "hard",
        "admin-1",
        "compromised",
      );
      expect(revoked.status).toBe("hard_revoked");
    });

    it("freezes a grant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read"],
        createdBy: "admin-1",
      });

      const frozen = adminService.revokeGrant(habitat.id, grant.id, "freeze", "admin-1");
      expect(frozen.status).toBe("frozen");
    });

    it("previews grant with task targets", () => {
      const habitat = setupHabitat();
      const preview = adminService.previewGrant({
        habitatId: habitat.id,
        targets: [
          { targetType: "task", targetId: "task-1" },
          { targetType: "task", targetId: "task-2" },
        ],
        rule: {},
      });
      expect(preview.matchCount).toBe(2);
      expect(preview.matchedTaskIds).toEqual(["task-1", "task-2"]);
    });

    it("previews grant with capability rule warning", () => {
      const habitat = setupHabitat();
      const preview = adminService.previewGrant({
        habitatId: habitat.id,
        rule: { capabilities: ["backend", "frontend"] },
      });
      expect(preview.warning).toContain("rule");
      expect(preview.warning).toContain("includeFutureMatches");
    });

    it("cannot revoke already-revoked grant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const grant = adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["read"],
        createdBy: "admin-1",
      });

      adminService.revokeGrant(habitat.id, grant.id, "soft", "admin-1");
      expect(() => adminService.revokeGrant(habitat.id, grant.id, "hard", "admin-1")).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // MCP Config & Credential Management
  // -------------------------------------------------------------------------

  describe("MCP Config & Credential Management", () => {
    beforeEach(() => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
    });

    it("creates credential with MCP config snippets and one-time secret", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const result = mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "mcp",
        clients: ["claude_code", "codex", "opencode"],
      });

      expect(result.credential.status).toBe("active");
      expect(result.plaintextSecret).toMatch(/^orcy_remote_/);
      expect(result.snippets).toHaveLength(3);
      expect(result.warning).toContain("only time");
      expect(result.standing).toBe("remote_contributor");

      const claudeSnippet = result.snippets.find((s) => s.clientId === "claude_code");
      expect(claudeSnippet?.configFormat).toBe("json");
      expect(claudeSnippet?.snippet).toContain("X-Orcy-Remote-Key");
      expect(claudeSnippet?.snippet).toContain(result.plaintextSecret);
    });

    it("does not return plaintext secret in metadata view", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const created = mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "mcp",
      });

      const metadata = mcpConfigService.getCredentialMetadata(habitat.id, created.credential.id);
      expect(metadata.credential.status).toBe("active");
      expect(metadata.warning).toContain("does not include the credential secret");
    });

    it("rotates credential and returns new one-time secret", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const created = mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "mcp",
      });

      const rotated = mcpConfigService.rotateCredentialWithConfig(
        habitat.id,
        created.credential.id,
        "admin-1",
      );

      expect(rotated.credential.id).not.toBe(created.credential.id);
      expect(rotated.plaintextSecret).toMatch(/^orcy_remote_/);
      expect(rotated.plaintextSecret).not.toBe(created.plaintextSecret);

      const oldCred = credentialRepo.getRemoteCredentialById(created.credential.id);
      expect(oldCred?.status).toBe("rotated");
    });

    it("revokes credential", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const created = mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "mcp",
      });

      const revoked = mcpConfigService.revokeCredential(
        habitat.id,
        created.credential.id,
        "admin-1",
        "no longer needed",
      );

      expect(revoked.status).toBe("revoked");
      expect(revoked.revokeReason).toBe("no longer needed");
    });

    it("regenerates config snippets without secret", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const created = mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "mcp",
      });

      const regenerated = mcpConfigService.regenerateConfigSnippets(
        habitat.id,
        created.credential.id,
        ["cursor", "generic"],
      );

      expect(regenerated.snippets).toHaveLength(2);
      const genericSnippet = regenerated.snippets.find((s) => s.clientId === "generic");
      expect(genericSnippet?.configFormat).toBe("shell");
      expect(genericSnippet?.snippet).not.toContain(created.plaintextSecret);
      expect(genericSnippet?.snippet).toContain("ORCY_REMOTE_KEY");
    });

    it("rejects credential creation for non-active participant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = participantRepo.createRemoteParticipant({
        remotePodId: pod.id,
        habitatId: habitat.id,
        participantType: "remote_orcy",
        displayName: "Pending Worker",
        standing: "remote_contributor",
      });
      // participant is still "pending"

      expect(() =>
        mcpConfigService.createCredentialWithConfig({
          habitatId: habitat.id,
          participantId: participant.id,
          credentialType: "mcp",
        }),
      ).toThrow();
    });

    it("rejects credential creation without ORCY_PUBLIC_URL", () => {
      delete process.env.ORCY_PUBLIC_URL;
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      expect(() =>
        mcpConfigService.createCredentialWithConfig({
          habitatId: habitat.id,
          participantId: participant.id,
          credentialType: "mcp",
        }),
      ).toThrow();
    });

    it("lists credentials for participant", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "mcp",
        label: "Cred 1",
      });
      mcpConfigService.createCredentialWithConfig({
        habitatId: habitat.id,
        participantId: participant.id,
        credentialType: "api",
        label: "Cred 2",
      });

      const creds = mcpConfigService.listCredentialsByParticipant(habitat.id, participant.id);
      expect(creds).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Management View
  // -------------------------------------------------------------------------

  describe("Management View", () => {
    it("returns aggregated pods/participants/grants with summary", () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      setupActiveParticipant(habitat.id, pod.id);
      adminService.createGrant({
        habitatId: habitat.id,
        remotePodId: pod.id,
        grantType: "baseline_observer",
        standing: "remote_observer",
        actionScopes: ["read"],
        createdBy: "admin-1",
      });

      const view = adminService.getManagementView(habitat.id);
      expect(view.summary.totalPods).toBe(1);
      expect(view.summary.activePods).toBe(1);
      expect(view.summary.totalParticipants).toBe(1);
      expect(view.summary.activeParticipants).toBe(1);
      expect(view.summary.totalGrants).toBe(1);
      expect(view.summary.activeGrants).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Route-Level HTTP Tests
  // -------------------------------------------------------------------------

  describe("Route Authentication", () => {
    it("returns 401 for anonymous admin routes", async () => {
      const habitat = setupHabitat();
      const res = await app!.inject({
        method: "GET",
        url: `/api/habitats/${habitat.id}/remote-access/readiness`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for viewer role on admin routes", async () => {
      const habitat = setupHabitat();
      const res = await app!.inject({
        method: "GET",
        url: `/api/habitats/${habitat.id}/remote-access/readiness`,
        headers: { authorization: `Bearer ${makeViewerToken()}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("allows admin role on admin routes", async () => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
      const habitat = setupHabitat();
      const res = await app!.inject({
        method: "GET",
        url: `/api/habitats/${habitat.id}/remote-access/readiness?manualInviteSelected=true`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ready).toBe(true);
    });

    it("allows anonymous access to invite preview route", async () => {
      const habitat = setupHabitat();
      const { oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_observer",
        invitedBy: "admin-1",
      });
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/invites/preview`,
        headers: { "x-orcy-invite-token": oneTimeToken },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.baselineStanding).toBe("remote_observer");
    });

    it("accepts manual invite via HTTP POST", async () => {
      const habitat = setupHabitat();
      const { oneTimeToken } = inviteService.createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_contributor",
        invitedBy: "admin-1",
      });
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/invites/accept`,
        headers: { "x-orcy-invite-token": oneTimeToken },
        payload: {
          podName: "HTTP Pod",
          participantDisplayName: "HTTP Admin",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.remotePod.name).toBe("HTTP Pod");
      expect(body.remoteParticipant.displayName).toBe("HTTP Admin");
    });

    it("creates credential via admin HTTP route with one-time secret", async () => {
      process.env.ORCY_PUBLIC_URL = "https://orcy.example.com";
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);
      const participant = setupActiveParticipant(habitat.id, pod.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/remote-access/participants/${participant.id}/credentials`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
        payload: {
          credentialType: "mcp",
          clients: ["claude_code"],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.plaintextSecret).toMatch(/^orcy_remote_/);
      expect(body.snippets).toHaveLength(1);
      expect(body.snippets[0].clientId).toBe("claude_code");
    });

    it("creates and revokes a grant via admin HTTP route", async () => {
      const habitat = setupHabitat();
      const pod = setupActivePod(habitat.id);

      const createRes = await app!.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/remote-access/grants`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
        payload: {
          remotePodId: pod.id,
          grantType: "scoped_elevation",
          standing: "remote_contributor",
          actionScopes: ["read", "claim"],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const grant = JSON.parse(createRes.body).grant;

      const revokeRes = await app!.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/remote-access/grants/${grant.id}/revoke`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
        payload: { mode: "soft", reason: "done" },
      });
      expect(revokeRes.statusCode).toBe(200);
      const revokedGrant = JSON.parse(revokeRes.body).grant;
      expect(revokedGrant.status).toBe("soft_revoked");
    });

    it("returns management view via HTTP", async () => {
      const habitat = setupHabitat();
      setupActivePod(habitat.id);

      const res = await app!.inject({
        method: "GET",
        url: `/api/habitats/${habitat.id}/remote-access/management`,
        headers: { authorization: `Bearer ${makeAdminToken()}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.totalPods).toBe(1);
    });
  });
});
