import * as habitatRepo from "../repositories/habitat.js";
import { verifyGitHubHmac, verifyGitLabToken } from "../config/integrationSecurity.js";

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

/**
 * PR/MR-path-only exact resolver (provider review-webhook binding, REC-06 C1):
 * collects ALL habitats whose `codeReviewSettings.githubSecret` HMAC-verifies
 * the presented raw body + signature.
 *
 * Deliberately NOT built on `githubSecretToHabitatId` — that map is keyed by
 * secret, so two habitats configured with the SAME secret collapse to one
 * entry (last rebuild wins) and the ambiguity would be invisible. Iterating
 * habitats directly makes zero/one/many verifications observable:
 * exactly one → proceed; zero or many → the PR path refuses (an ambiguous
 * binding is a refusal, not a first-match roulette). The shared first-match
 * seam (`findHabitatIdByGithubSignature`, used by the release path and the
 * verified-ingress posture check) and the CI/CD store are untouched — this
 * resolver is consumed by the PR/MR webhook handlers only.
 */
export function resolveCodeReviewHabitatIdsByGithubSignature(
  rawBody: string,
  signature: string | undefined,
): string[] {
  if (!signature) return [];
  const matches = new Set<string>();
  for (const habitat of habitatRepo.listHabitats()) {
    const secret = habitat.codeReviewSettings?.githubSecret;
    if (secret && verifyGitHubHmac(rawBody, signature, secret)) {
      matches.add(habitat.id);
    }
  }
  return [...matches];
}

/**
 * PR/MR-path-only exact resolver (GitLab twin of
 * {@link resolveCodeReviewHabitatIdsByGithubSignature}): collects ALL habitats
 * whose `codeReviewSettings.gitlabSecret` matches the presented token
 * (timing-safe compare). Zero or many matches are refusal states; only the
 * MR/note webhook handlers consume this.
 */
export function resolveCodeReviewHabitatIdsByGitlabToken(token: string | undefined): string[] {
  if (!token) return [];
  const matches = new Set<string>();
  for (const habitat of habitatRepo.listHabitats()) {
    const secret = habitat.codeReviewSettings?.gitlabSecret;
    if (secret && verifyGitLabToken(token, secret)) {
      matches.add(habitat.id);
    }
  }
  return [...matches];
}
