import {
  GITHUB_ACTIONS_RUN_URL_PATTERN,
  GITHUB_COMMIT_URL_PATTERN,
  GITHUB_PR_URL_PATTERN,
  GITLAB_COMMIT_URL_PATTERN,
  GITLAB_MR_URL_PATTERN,
  GITLAB_PIPELINE_URL_PATTERN,
} from "@orcy/shared";
import type { ParsedUrl } from "./types.js";

/** Matches a URL against known GitHub and GitLab pull request, commit, and pipeline patterns and returns its evidence type, provider, repo slug, and identifier, or null if unrecognized. */
export function parseUrl(url: string): ParsedUrl {
  let match: RegExpMatchArray | null;

  match = url.match(GITHUB_PR_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pull_request",
      provider: "github",
      repoSlug: `${match[1]}/${match[2]}`,
      identifier: match[3],
    };
  }

  match = url.match(GITHUB_COMMIT_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "commit",
      provider: "github",
      repoSlug: `${match[1]}/${match[2]}`,
      identifier: match[3],
    };
  }

  match = url.match(GITHUB_ACTIONS_RUN_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pipeline_run",
      provider: "github",
      repoSlug: `${match[1]}/${match[2]}`,
      identifier: match[3],
    };
  }

  match = url.match(GITLAB_MR_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pull_request",
      provider: "gitlab",
      repoSlug: match[1],
      identifier: match[2],
    };
  }

  match = url.match(GITLAB_COMMIT_URL_PATTERN);
  if (match) {
    return { evidenceType: "commit", provider: "gitlab", repoSlug: match[1], identifier: match[2] };
  }

  match = url.match(GITLAB_PIPELINE_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pipeline_run",
      provider: "gitlab",
      repoSlug: match[1],
      identifier: match[2],
    };
  }

  return null;
}

/** Returns a lowercased, fragment-stripped canonical form of a URL for deduplication and comparison. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hashIdx = parsed.href.indexOf("#");
    return hashIdx >= 0 ? parsed.href.slice(0, hashIdx).toLowerCase() : parsed.href.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
