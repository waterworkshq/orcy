import * as boardRepo from '../repositories/board.js';
import { verifyGitHubHmac } from '../config/integrationSecurity.js';

const secretToBoardId = new Map<string, string>();
const githubSecretToBoardId = new Map<string, string>();

export function rebuildCache(): void {
  secretToBoardId.clear();
  githubSecretToBoardId.clear();
  const boards = boardRepo.listBoards();
  for (const board of boards) {
    const settings = board.codeReviewSettings;
    if (!settings) continue;
    if (settings.gitlabSecret) {
      secretToBoardId.set(settings.gitlabSecret, board.id);
    }
    if (settings.githubSecret) {
      githubSecretToBoardId.set(settings.githubSecret, board.id);
    }
  }
}

export function lookupBoardIdBySecret(secret: string): string | null {
  return secretToBoardId.get(secret) ?? null;
}

export function findBoardIdByGithubSignature(rawBody: string, signature: string): string | null {
  for (const [secret, boardId] of githubSecretToBoardId) {
    if (verifyGitHubHmac(rawBody, signature, secret)) {
      return boardId;
    }
  }
  return null;
}

export function hasGithubSecretsConfigured(): boolean {
  return githubSecretToBoardId.size > 0;
}

export function hasAnySecretsConfigured(): boolean {
  return secretToBoardId.size > 0 || githubSecretToBoardId.size > 0;
}
