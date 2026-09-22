import type { CodeReviewSettings } from "../../models/index.js";

/**
 * Canonicalizes a provider repository/project identity from a webhook payload
 * or stored config into its matching form (a decimal string), or returns null
 * for anything that cannot be trusted as an immutable id:
 * - JSON string: must be non-empty canonical decimal digits (strings are the
 *   precision-loss-free carrier — any length accepted).
 * - JSON number: must be a positive safe integer (range-checked BEFORE any
 *   coercion — a fractional or >2^53 number is rejected, never rounded).
 * - Anything else (undefined, null, boolean, object, negative, NaN) rejects.
 */
export function normalizeProviderRepoId(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value === "string") {
    return /^\d+$/.test(value) ? value : null;
  }
  return null;
}

/**
 * Trusted-repository allowlist check (REC-06 C2). The trust tuple is
 * `(provider, immutable id)` — the event's GitHub `repository.id` must appear
 * in the SIGNATURE-habitat's `codeReviewSettings.githubRepositories`.
 * `fullName`/`full_name` are display metadata and never participate.
 * An absent/undefined allowlist reads as `[]` (fail-closed: legacy habitats
 * refuse the PR path until an operator configures ids).
 */
export function isGithubRepoAllowed(settings: CodeReviewSettings, repoId: string): boolean {
  return (settings.githubRepositories ?? []).some((entry) => entry.id === repoId);
}

/** GitLab twin of {@link isGithubRepoAllowed}, keyed on `project.id`. */
export function isGitlabProjectAllowed(settings: CodeReviewSettings, projectId: string): boolean {
  return (settings.gitlabProjects ?? []).some((entry) => entry.id === projectId);
}
