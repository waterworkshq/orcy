import {
  isRemotePosture,
  verifyGitHubHmac,
  verifyGitLabToken,
} from "../../config/integrationSecurity.js";
import {
  lookupHabitatIdBySecret,
  hasAnySecretsConfigured,
  findHabitatIdByGithubSignature,
  hasGithubSecretsConfigured,
} from "../boardSecretCache.js";
import * as habitatRepo from "../../repositories/board.js";

/** HTTP response shape returned by a webhook handler. */
export interface WebhookResponse {
  statusCode: number;
  body: unknown;
}

/** Verifies GitHub signatures and GitLab tokens against configured secrets. */
export interface WebhookSecretSource {
  verifyGitHubSignature(
    rawBody: string,
    signature: string | undefined,
  ): { matched: boolean; secretsPresent: boolean };
  verifyGitLabToken(providedToken: string | undefined): {
    matched: boolean;
    secretsPresent: boolean;
  };
}

/** Creates a verifier backed by board-level code review secrets. */
export function createCodeReviewSecretSource(): WebhookSecretSource {
  return {
    verifyGitHubSignature(rawBody: string, signature: string | undefined) {
      const matched = signature
        ? findHabitatIdByGithubSignature(rawBody, signature) !== null
        : false;
      return { matched, secretsPresent: hasGithubSecretsConfigured() };
    },
    verifyGitLabToken(providedToken: string | undefined) {
      const matched = providedToken ? lookupHabitatIdBySecret(providedToken) !== null : false;
      return { matched, secretsPresent: hasAnySecretsConfigured() };
    },
  };
}

/** Creates a verifier backed by habitat CI/CD settings. */
export function createCiCdSecretSource(): WebhookSecretSource {
  return {
    verifyGitHubSignature(rawBody: string, signature: string | undefined) {
      const habitats = habitatRepo.listHabitats();
      let matched = false;
      let secretsPresent = false;
      for (const habitat of habitats) {
        const ciCd = habitat.ciCdSettings;
        if (!ciCd?.githubSecret) continue;
        secretsPresent = true;
        if (signature && verifyGitHubHmac(rawBody, signature, ciCd.githubSecret)) {
          matched = true;
          break;
        }
      }
      return { matched, secretsPresent };
    },
    verifyGitLabToken(providedToken: string | undefined) {
      const habitats = habitatRepo.listHabitats();
      let matched = false;
      let secretsPresent = false;
      for (const habitat of habitats) {
        const ciCd = habitat.ciCdSettings;
        if (!ciCd?.gitlabSecret) continue;
        secretsPresent = true;
        if (providedToken && verifyGitLabToken(providedToken, ciCd.gitlabSecret)) {
          matched = true;
          break;
        }
      }
      return { matched, secretsPresent };
    },
  };
}

type EventHandler = (body: unknown) => unknown | Promise<unknown>;

/** Validates a GitHub webhook signature and dispatches to the matching handler. */
export async function handleGitHubWebhook(
  source: WebhookSecretSource,
  params: {
    body: Record<string, unknown>;
    rawBody: string;
    event: string | undefined;
    signature: string | undefined;
  },
  handlers: Record<string, EventHandler>,
  options?: { failClosed?: boolean },
): Promise<WebhookResponse> {
  const { body, rawBody, event, signature } = params;

  if (!event) {
    return { statusCode: 400, body: { error: "Missing X-GitHub-Event header" } };
  }

  const { matched, secretsPresent } = source.verifyGitHubSignature(rawBody, signature);

  if (!matched) {
    const shouldReject = options?.failClosed ? secretsPresent || isRemotePosture() : secretsPresent;
    if (shouldReject) {
      return { statusCode: 401, body: { error: "Invalid or missing signature" } };
    }
  }

  const handler = handlers[event];
  if (handler) {
    const result = await handler(body);
    // Handlers may include a statusCode to override the default 200
    // (e.g. validation errors → 400 so GitHub redelivers).
    const code =
      result && typeof result === "object" && "statusCode" in result
        ? (result as { statusCode: number }).statusCode
        : 200;
    return { statusCode: code, body: result };
  }

  return { statusCode: 200, body: { status: "ignored", event } };
}

/** Validates a GitLab webhook token and dispatches to the matching handler. */
export function handleGitLabWebhook(
  source: WebhookSecretSource,
  params: {
    body: Record<string, unknown>;
    providedToken: string | undefined;
    objectKind: string | undefined;
  },
  handlers: Record<string, EventHandler>,
  options?: { failClosed?: boolean },
): WebhookResponse {
  const { body, providedToken, objectKind } = params;

  if (!objectKind) {
    return { statusCode: 400, body: { error: "Missing object_kind" } };
  }

  const { matched, secretsPresent } = source.verifyGitLabToken(providedToken);

  if (!matched) {
    const shouldReject = options?.failClosed ? secretsPresent || isRemotePosture() : secretsPresent;
    if (shouldReject) {
      return { statusCode: 401, body: { error: "Invalid or missing token" } };
    }
  }

  const handler = handlers[objectKind];
  if (handler) {
    return { statusCode: 200, body: handler(body) };
  }

  return { statusCode: 200, body: { status: "ignored", objectKind } };
}
