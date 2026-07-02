import * as releaseTriggerService from "./releaseTriggerService.js";

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
 * `published` actions on non-draft, non-prerelease releases proceed; drafts
 * and prereleases are ignored (consistent with the semver engine rejecting
 * pre-release tags). The version is parsed from `release.tag_name` (leading `v`
 * stripped by the trigger service) and recorded with provenance
 * `github_release_webhook`.
 *
 * A failure inside `detectAndActivate` is caught and surfaced as an
 * `{status:"error"}` body so one malformed release doesn't 500 the webhook
 * response for every subsequent delivery.
 */
export async function handleGitHubReleaseEvent(
  body: GitHubReleaseEvent,
  ctx: HandleContext,
): Promise<{ status: string; error?: string; release?: unknown }> {
  const release = body.release;
  if (body.action !== "published" || !release || release.draft || release.prerelease) {
    return { status: "ignored" };
  }

  try {
    const result = await releaseTriggerService.detectAndActivate(ctx.habitatId, release.tag_name, {
      detectedBy: "github_release_webhook",
      releaseNotes: release.body ?? release.name ?? undefined,
    });
    return { status: "recorded", release: result.release };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Unknown error" };
  }
}
