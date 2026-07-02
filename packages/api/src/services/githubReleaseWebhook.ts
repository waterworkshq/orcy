import * as releaseTriggerService from "./releaseTriggerService.js";
import { parseVersion, isPreRelease } from "@orcy/shared";

interface GitHubReleaseEvent {
  action: string;
  release: {
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
  };
  repository: { full_name: string };
}

interface HandleContext {
  habitatId: string;
}

/**
 * Handles a GitHub `release` webhook event for the resolved habitat. Only
 * `published` and `released` actions on non-draft, non-prerelease releases
 * proceed; drafts and prereleases are ignored. Semver pre-release tags
 * (e.g. `-rc.1`, `-beta`) are also skipped — they're a preview signal, not
 * a release event. The version is parsed from `release.tag_name` (leading
 * `v` stripped by the trigger service) and recorded with provenance
 * `github_release_webhook`.
 *
 * Both `published` and `released` are accepted because different GitHub
 * tooling paths emit different actions (gh-release CLI emits `released`,
 * GitHub UI emits `published`). The `draft` and `prerelease` filters
 * already handle the distinction.
 *
 * Validation errors (bad version, first-release requires type) return
 * `statusCode: 400` so the webhook dispatcher can propagate a non-2xx to
 * GitHub, enabling redelivery (REL-1).
 */
export async function handleGitHubReleaseEvent(
  body: GitHubReleaseEvent,
  ctx: HandleContext,
): Promise<{ status: string; statusCode?: number; error?: string; release?: unknown }> {
  const release = body.release;
  const isReleaseAction = body.action === "published" || body.action === "released";
  if (!isReleaseAction || !release || release.draft || release.prerelease) {
    return { status: "ignored" };
  }

  // Semver pre-release tags (v1.0.0-rc.1, v0.1.0-beta) are skipped even when
  // GitHub's prerelease flag is false (user error or tooling mismatch).
  try {
    if (isPreRelease(parseVersion(release.tag_name))) {
      return { status: "ignored" };
    }
  } catch {
    return { status: "error", statusCode: 400, error: `Invalid version tag: ${release.tag_name}` };
  }

  try {
    const result = await releaseTriggerService.detectAndActivate(ctx.habitatId, release.tag_name, {
      detectedBy: "github_release_webhook",
      releaseNotes: release.body ?? release.name ?? undefined,
    });
    return { status: "recorded", release: result.release };
  } catch (err) {
    // Validation errors (bad version, first-release requires type) are 400;
    // unexpected errors are 500.
    const message = err instanceof Error ? err.message : "Unknown error";
    const isValidation = /invalid version|explicit type/i.test(message);
    return { status: "error", statusCode: isValidation ? 400 : 500, error: message };
  }
}
