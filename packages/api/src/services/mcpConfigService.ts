import type { RemoteCredentialType } from "@orcy/shared/types";
import * as credentialService from "./remoteCredentialService.js";
import type { CredentialWithSecret } from "./remoteCredentialService.js";
import * as credentialRepo from "../repositories/remoteCredential.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as podRepo from "../repositories/remotePod.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteCredentialRow } from "../repositories/remoteCredential.js";
import { getBaseUrl } from "./shareHabitatReadinessService.js";
import { notFound, badRequest } from "../errors.js";

export interface CredentialPublicView {
  id: string;
  remoteParticipantId: string;
  habitatId: string;
  credentialType: string;
  label: string;
  status: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rotatedFromId: string | null;
  rotatedAt: string | null;
  rotatedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toCredentialView(row: RemoteCredentialRow): CredentialPublicView {
  const { secretHash: _stripped, ...public_ } = row;
  return public_;
}

export type McpClientId =
  | "claude_code"
  | "codex"
  | "opencode"
  | "cursor"
  | "gemini_cli"
  | "generic";

export interface McpConfigSnippet {
  clientId: McpClientId;
  clientName: string;
  configFormat: "json" | "shell" | "yaml";
  snippet: string;
  placementHint: string;
}

export interface McpConfigResult {
  credential: CredentialPublicView;
  plaintextSecret: string | null;
  snippets: McpConfigSnippet[];
  standing: string;
  grantSummary: {
    grantType: string;
    actionScopes: string[];
    expiresAt: string | null;
  } | null;
  warning: string;
  baseUrl: string;
}

export interface CreateCredentialInput {
  habitatId: string;
  participantId: string;
  credentialType: RemoteCredentialType;
  label?: string;
  expiresAt?: string | null;
  createdBy?: string | null;
  clients?: McpClientId[];
}

const CLIENT_NAMES: Record<McpClientId, string> = {
  claude_code: "Claude Code",
  codex: "Codex / OpenAI CLI",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini_cli: "Gemini CLI",
  generic: "Generic MCP Client",
};

/**
 * Builds ready-to-paste {@link McpConfigSnippet} blocks for the requested {@link McpClientId} values, embedding the supplied plaintext secret when present or a placeholder otherwise.
 */
export function generateSnippets(
  baseUrl: string,
  credentialId: string,
  plaintextSecret: string | null,
  clients: McpClientId[],
): McpConfigSnippet[] {
  const headerName = "X-Orcy-Remote-Key";
  const apiUrl = `${baseUrl}/api/shared`;

  return clients.map((clientId) => {
    const secretRef = plaintextSecret ?? `<your-remote-key-for-${credentialId}>`;

    switch (clientId) {
      case "claude_code":
      case "opencode":
        return {
          clientId,
          clientName: CLIENT_NAMES[clientId],
          configFormat: "json",
          snippet: JSON.stringify(
            {
              mcpServers: {
                orcy: {
                  type: "url",
                  url: `${apiUrl}/mcp`,
                  headers: { [headerName]: secretRef },
                },
              },
            },
            null,
            2,
          ),
          placementHint:
            clientId === "claude_code"
              ? "Save to ~/.claude.json or your project .mcp.json"
              : "Add to your opencode configuration file (~/.config/opencode/opencode.json)",
        };

      case "codex":
        return {
          clientId,
          clientName: CLIENT_NAMES[clientId],
          configFormat: "json",
          snippet: JSON.stringify(
            {
              mcp_servers: {
                orcy: {
                  url: `${apiUrl}/mcp`,
                  headers: { [headerName]: secretRef },
                },
              },
            },
            null,
            2,
          ),
          placementHint: "Add to your Codex configuration (~/.codex/config.json)",
        };

      case "cursor":
        return {
          clientId,
          clientName: CLIENT_NAMES[clientId],
          configFormat: "json",
          snippet: JSON.stringify(
            {
              mcp: {
                servers: {
                  orcy: {
                    url: `${apiUrl}/mcp`,
                    headers: { [headerName]: secretRef },
                  },
                },
              },
            },
            null,
            2,
          ),
          placementHint: "Add to Cursor Settings > MCP Servers configuration",
        };

      case "gemini_cli":
        return {
          clientId,
          clientName: CLIENT_NAMES[clientId],
          configFormat: "json",
          snippet: JSON.stringify(
            {
              mcpServers: {
                orcy: {
                  url: `${apiUrl}/mcp`,
                  headers: { [headerName]: secretRef },
                },
              },
            },
            null,
            2,
          ),
          placementHint: "Add to ~/.gemini/settings.json",
        };

      case "generic":
        return {
          clientId,
          clientName: CLIENT_NAMES[clientId],
          configFormat: "shell",
          snippet: `# Set environment variable for Orcy remote access
export ORCY_REMOTE_KEY="${secretRef}"
export ORCY_API_URL="${apiUrl}"
# Header: ${headerName}: <your-key>`,
          placementHint:
            "Use these environment variables with any MCP client that supports custom headers",
        };
    }
  });
}

function buildWarning(hasSecret: boolean): string {
  if (!hasSecret) {
    return "This view does not include the credential secret. The secret was shown only once at creation/rotation time.";
  }
  return "This is the only time the credential secret will be shown. Store it securely — it cannot be retrieved later.";
}

/**
 * Creates and persists a new remote credential for an active participant, returning a {@link McpConfigResult} that includes the one-time plaintext secret, generated client snippets, standing, and active grant summary.
 */
export function createCredentialWithConfig(input: CreateCredentialInput): McpConfigResult {
  const participant = participantRepo.getRemoteParticipantById(input.participantId);
  if (!participant || participant.habitatId !== input.habitatId) {
    throw notFound("Remote participant not found");
  }
  if (participant.status !== "active") {
    throw badRequest("Participant must be active to create credentials", "PARTICIPANT_NOT_ACTIVE");
  }

  const pod = podRepo.getRemotePodById(participant.remotePodId);
  if (!pod) throw notFound("Remote pod not found for participant");

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw badRequest("ORCY_PUBLIC_URL must be configured before creating remote credentials");
  }

  const { credential, plaintextSecret }: CredentialWithSecret =
    credentialService.createCredentialWithSecret({
      remoteParticipantId: input.participantId,
      habitatId: input.habitatId,
      credentialType: input.credentialType,
      label: input.label,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    });

  const clients = input.clients ?? ["claude_code", "codex", "opencode"];
  const snippets = generateSnippets(baseUrl, credential.id, plaintextSecret, clients);

  // Get grant summary for the active grant
  const activeGrants = grantRepo.getActiveGrantsByParticipant(input.participantId);
  const grantSummary =
    activeGrants.length > 0
      ? {
          grantType: activeGrants[0].grantType,
          actionScopes: activeGrants[0].actionScopes,
          expiresAt: activeGrants[0].expiresAt,
        }
      : null;

  return {
    credential: toCredentialView(credential),
    plaintextSecret,
    snippets,
    standing: participant.standing,
    grantSummary,
    warning: buildWarning(true),
    baseUrl,
  };
}

/**
 * Returns the {@link CredentialPublicView} for a credential along with the participant's standing and active grant summary, without exposing the plaintext secret.
 */
export function getCredentialMetadata(
  habitatId: string,
  credentialId: string,
): {
  credential: CredentialPublicView;
  standing: string;
  grantSummary: {
    grantType: string;
    actionScopes: string[];
    expiresAt: string | null;
  } | null;
  warning: string;
} {
  const credential = credentialService.verifyRemoteKeyById(credentialId);
  if (!credential || credential.habitatId !== habitatId) {
    throw notFound("Credential not found");
  }

  const participant = participantRepo.getRemoteParticipantById(credential.remoteParticipantId);
  const activeGrants = participant ? grantRepo.getActiveGrantsByParticipant(participant.id) : [];

  return {
    credential: toCredentialView(credential),
    standing: participant?.standing ?? "unknown",
    grantSummary:
      activeGrants.length > 0
        ? {
            grantType: activeGrants[0].grantType,
            actionScopes: activeGrants[0].actionScopes,
            expiresAt: activeGrants[0].expiresAt,
          }
        : null,
    warning: buildWarning(false),
  };
}

/**
 * Rotates an existing credential, persisting the revocation of the old key alongside a new plaintext secret, and returns a {@link McpConfigResult} with regenerated client snippets and grant context.
 */
export function rotateCredentialWithConfig(
  habitatId: string,
  credentialId: string,
  rotatedBy?: string | null,
  clients?: McpClientId[],
): McpConfigResult {
  const existing = credentialService.verifyRemoteKeyById(credentialId);
  if (!existing || existing.habitatId !== habitatId) {
    throw notFound("Credential not found");
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw badRequest("ORCY_PUBLIC_URL must be configured");
  }

  const { oldCredential, newCredential, plaintextSecret } = credentialService.rotateCredential(
    credentialId,
    rotatedBy,
  );

  if (!newCredential || !oldCredential) throw notFound("Credential rotation failed");

  const participant = participantRepo.getRemoteParticipantById(newCredential.remoteParticipantId);
  const snippets = generateSnippets(
    baseUrl,
    newCredential.id,
    plaintextSecret,
    clients ?? ["claude_code", "codex", "opencode"],
  );

  const activeGrants = participant ? grantRepo.getActiveGrantsByParticipant(participant.id) : [];

  return {
    credential: toCredentialView(newCredential),
    plaintextSecret,
    snippets,
    standing: participant?.standing ?? "unknown",
    grantSummary:
      activeGrants.length > 0
        ? {
            grantType: activeGrants[0].grantType,
            actionScopes: activeGrants[0].actionScopes,
            expiresAt: activeGrants[0].expiresAt,
          }
        : null,
    warning: buildWarning(true),
    baseUrl,
  };
}

/**
 * Revokes the named credential and returns its stripped {@link CredentialPublicView}.
 */
export function revokeCredential(
  habitatId: string,
  credentialId: string,
  revokedBy?: string | null,
  revokeReason?: string,
): CredentialPublicView {
  const existing = credentialService.verifyRemoteKeyById(credentialId);
  if (!existing || existing.habitatId !== habitatId) {
    throw notFound("Credential not found");
  }
  const revoked = credentialService.revokeCredential(credentialId, revokedBy, revokeReason);
  if (!revoked) throw notFound("Credential not found");
  return toCredentialView(revoked);
}

/**
 * Returns the active {@link CredentialPublicView}s for the participant scoped to the given habitat.
 */
export function listCredentialsByParticipant(
  habitatId: string,
  participantId: string,
): CredentialPublicView[] {
  const participant = participantRepo.getRemoteParticipantById(participantId);
  if (!participant || participant.habitatId !== habitatId) {
    throw notFound("Remote participant not found");
  }
  return credentialRepo.getActiveCredentialsByParticipant(participantId).map(toCredentialView);
}

/**
 * Regenerates {@link McpConfigSnippet} blocks for an existing credential without exposing the plaintext secret.
 */
export function regenerateConfigSnippets(
  habitatId: string,
  credentialId: string,
  clients: McpClientId[],
): {
  credential: CredentialPublicView;
  snippets: McpConfigSnippet[];
  warning: string;
  baseUrl: string;
} {
  const credential = credentialService.verifyRemoteKeyById(credentialId);
  if (!credential || credential.habitatId !== habitatId) {
    throw notFound("Credential not found");
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw badRequest("ORCY_PUBLIC_URL must be configured");
  }

  const snippets = generateSnippets(baseUrl, credential.id, null, clients);

  return {
    credential: toCredentialView(credential),
    snippets,
    warning: buildWarning(false),
    baseUrl,
  };
}
