import { isRemotePosture, verifyGitHubHmac, verifyGitLabToken } from '../../config/integrationSecurity.js';
import {
  lookupBoardIdBySecret,
  hasAnySecretsConfigured,
  findBoardIdByGithubSignature,
  hasGithubSecretsConfigured,
} from '../boardSecretCache.js';
import * as boardRepo from '../../repositories/board.js';

export interface WebhookResponse {
  statusCode: number;
  body: unknown;
}

export interface WebhookSecretSource {
  verifyGitHubSignature(rawBody: string, signature: string | undefined): { matched: boolean; secretsPresent: boolean };
  verifyGitLabToken(providedToken: string | undefined): { matched: boolean; secretsPresent: boolean };
}

export function createCodeReviewSecretSource(): WebhookSecretSource {
  return {
    verifyGitHubSignature(rawBody: string, signature: string | undefined) {
      const matched = signature ? findBoardIdByGithubSignature(rawBody, signature) !== null : false;
      return { matched, secretsPresent: hasGithubSecretsConfigured() };
    },
    verifyGitLabToken(providedToken: string | undefined) {
      const matched = providedToken ? lookupBoardIdBySecret(providedToken) !== null : false;
      return { matched, secretsPresent: hasAnySecretsConfigured() };
    },
  };
}

export function createCiCdSecretSource(): WebhookSecretSource {
  return {
    verifyGitHubSignature(rawBody: string, signature: string | undefined) {
      const boards = boardRepo.listBoards();
      let matched = false;
      let secretsPresent = false;
      for (const board of boards) {
        const raw = (board as unknown as Record<string, unknown>).ci_cd_settings;
        if (!raw || typeof raw !== 'string') continue;
        try {
          const settings = JSON.parse(raw) as { githubSecret?: string };
          if (settings.githubSecret) {
            secretsPresent = true;
            if (signature && verifyGitHubHmac(rawBody, signature, settings.githubSecret)) {
              matched = true;
              break;
            }
          }
        } catch { /* continue */ }
      }
      return { matched, secretsPresent };
    },
    verifyGitLabToken(providedToken: string | undefined) {
      const boards = boardRepo.listBoards();
      let matched = false;
      let secretsPresent = false;
      for (const board of boards) {
        const raw = (board as unknown as Record<string, unknown>).ci_cd_settings;
        if (!raw || typeof raw !== 'string') continue;
        try {
          const settings = JSON.parse(raw) as { gitlabSecret?: string };
          if (settings.gitlabSecret) {
            secretsPresent = true;
            if (providedToken && verifyGitLabToken(providedToken, settings.gitlabSecret)) {
              matched = true;
              break;
            }
          }
        } catch { /* continue */ }
      }
      return { matched, secretsPresent };
    },
  };
}

type EventHandler = (body: unknown) => unknown;

export function handleGitHubWebhook(
  source: WebhookSecretSource,
  params: {
    body: Record<string, unknown>;
    rawBody: string;
    event: string | undefined;
    signature: string | undefined;
  },
  handlers: Record<string, EventHandler>,
  options?: { failClosed?: boolean },
): WebhookResponse {
  const { body, rawBody, event, signature } = params;

  if (!event) {
    return { statusCode: 400, body: { error: 'Missing X-GitHub-Event header' } };
  }

  const { matched, secretsPresent } = source.verifyGitHubSignature(rawBody, signature);

  if (!matched) {
    const shouldReject = options?.failClosed
      ? secretsPresent || isRemotePosture()
      : secretsPresent;
    if (shouldReject) {
      return { statusCode: 401, body: { error: 'Invalid or missing signature' } };
    }
  }

  const handler = handlers[event];
  if (handler) {
    return { statusCode: 200, body: handler(body) };
  }

  return { statusCode: 200, body: { status: 'ignored', event } };
}

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
    return { statusCode: 400, body: { error: 'Missing object_kind' } };
  }

  const { matched, secretsPresent } = source.verifyGitLabToken(providedToken);

  if (!matched) {
    const shouldReject = options?.failClosed
      ? secretsPresent || isRemotePosture()
      : secretsPresent;
    if (shouldReject) {
      return { statusCode: 401, body: { error: 'Invalid or missing token' } };
    }
  }

  const handler = handlers[objectKind];
  if (handler) {
    return { statusCode: 200, body: handler(body) };
  }

  return { statusCode: 200, body: { status: 'ignored', objectKind } };
}
