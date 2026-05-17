import * as habitatRepo from '../repositories/board.js';
import { verifyGitHubHmac } from '../config/integrationSecurity.js';

const secretToHabitatId = new Map<string, string>();
const githubSecretToHabitatId = new Map<string, string>();

export function rebuildCache(): void {
  secretToHabitatId.clear();
  githubSecretToHabitatId.clear();
  const habitats = habitatRepo.listHabitats();
  for (const habitat of habitats) {
    const settings = habitat.codeReviewSettings;
    if (!settings) continue;
    if (settings.gitlabSecret) {
      secretToHabitatId.set(settings.gitlabSecret, habitat.id);
    }
    if (settings.githubSecret) {
      githubSecretToHabitatId.set(settings.githubSecret, habitat.id);
    }
  }
}

export function lookupHabitatIdBySecret(secret: string): string | null {
  return secretToHabitatId.get(secret) ?? null;
}

export function findHabitatIdByGithubSignature(rawBody: string, signature: string): string | null {
  for (const [secret, habitatId] of githubSecretToHabitatId) {
    if (verifyGitHubHmac(rawBody, signature, secret)) {
      return habitatId;
    }
  }
  return null;
}

export function hasGithubSecretsConfigured(): boolean {
  return githubSecretToHabitatId.size > 0;
}

export function hasAnySecretsConfigured(): boolean {
  return secretToHabitatId.size > 0 || githubSecretToHabitatId.size > 0;
}
