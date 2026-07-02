import * as habitatRepo from "../repositories/board.js";
import { verifyGitHubHmac } from "../config/integrationSecurity.js";

const secretToHabitatId = new Map<string, string>();
const githubSecretToHabitatId = new Map<string, string>();
const ciCdGithubSecretToHabitatId = new Map<string, string>();

/** Rebuilds the in-memory webhook secret to habitat ID lookup maps from current habitat settings. Must be called after habitat settings change. */
export function rebuildCache(): void {
  secretToHabitatId.clear();
  githubSecretToHabitatId.clear();
  ciCdGithubSecretToHabitatId.clear();
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

    const ciCd = habitat.ciCdSettings;
    if (!ciCd) continue;
    if (ciCd.githubSecret) {
      ciCdGithubSecretToHabitatId.set(ciCd.githubSecret, habitat.id);
    }
  }
}

/** Resolves a habitat ID from a GitLab webhook secret, or `null` if the secret is unknown. */
export function lookupHabitatIdBySecret(secret: string): string | null {
  return secretToHabitatId.get(secret) ?? null;
}

/** Resolves a habitat ID by HMAC-verifying a GitHub webhook signature against all configured secrets, or `null` if none match. */
export function findHabitatIdByGithubSignature(rawBody: string, signature: string): string | null {
  for (const [secret, habitatId] of githubSecretToHabitatId) {
    if (verifyGitHubHmac(rawBody, signature, secret)) {
      return habitatId;
    }
  }
  return null;
}

/**
 * Resolves a habitat ID by HMAC-verifying a GitHub webhook signature against
 * all configured CI/CD secrets (`ci_cd_settings.githubSecret`), or `null` if
 * none match. Mirrors {@link findHabitatIdByGithubSignature} but iterates the
 * CI/CD secret store, which is distinct from the code-review secret store —
 * the `workflow_run` webhook arrives on `/webhooks/github-ci` whose
 * `createCiCdSecretSource` verifies against `ci_cd_settings.githubSecret`, not
 * `codeReviewSettings.githubSecret`. The two stores must not be crossed.
 */
export function findHabitatIdByCiCdSignature(rawBody: string, signature: string): string | null {
  for (const [secret, habitatId] of ciCdGithubSecretToHabitatId) {
    if (verifyGitHubHmac(rawBody, signature, secret)) {
      return habitatId;
    }
  }
  return null;
}

/** Returns whether any habitat has a GitHub webhook secret configured. */
export function hasGithubSecretsConfigured(): boolean {
  return githubSecretToHabitatId.size > 0;
}

/** Returns whether any habitat has a GitLab or GitHub webhook secret configured. */
export function hasAnySecretsConfigured(): boolean {
  return secretToHabitatId.size > 0 || githubSecretToHabitatId.size > 0;
}
