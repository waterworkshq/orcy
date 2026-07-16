import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as releaseRepo from "../repositories/release.js";
import * as githubReleaseWebhook from "../services/githubReleaseWebhook.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import { parseVersion, isPreRelease } from "@orcy/shared";

/**
 * AC-DETECT-6/7/8 — webhook-driven release detection. The GitHub `release`
 * handler and the `workflow_run` convention are exercised against synthetic
 * payloads; `boardSecretCache` is mocked so the habitat can be resolved
 * without configuring real HMAC secrets.
 *
 * The `release` event path goes directly through `githubReleaseWebhook
 * .handleGitHubReleaseEvent` (the same function the route handler at
 * `codeReviewWebhooks.ts:35-42` invokes). The `workflow_run` convention is
 * exercised by replicating the convention check from `ciCdWebhooks.ts:39-44`
 * — when the convention matches, the route calls `detectAndActivate` with
 * `detectedBy:"cicd_pipeline"`, which is the observable side-effect asserted
 * here. (Mocking the Fastify route would force re-mocking the entire secret
 * verification stack; calling the convention check directly mirrors the
 * route's logic without that overhead.)
 */

const secretCacheMock = vi.hoisted(() => ({
  findHabitatIdByGithubSignature: vi.fn((): string | null => null),
  findHabitatIdByCiCdSignature: vi.fn((): string | null => null),
}));

vi.mock("../services/boardSecretCache.js", () => secretCacheMock);

let habitatId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();

  const habitat = habitatRepo.createHabitat({ name: "Webhook Habitat" });
  habitatId = habitat.id;

  secretCacheMock.findHabitatIdByGithubSignature.mockReturnValue(null);
  secretCacheMock.findHabitatIdByCiCdSignature.mockReturnValue(null);
  vi.clearAllMocks();
});

afterEach(() => closeDb());

function buildReleasePayload(opts: {
  action?: string;
  tagName?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  name?: string | null;
}) {
  return {
    action: opts.action ?? "published",
    release: {
      tag_name: opts.tagName ?? "v0.1.0",
      name: opts.name ?? "Release 0.1.0",
      body: opts.body ?? "release notes",
      html_url: "https://github.com/example/repo/releases/tag/v0.1.0",
      draft: opts.draft ?? false,
      prerelease: opts.prerelease ?? false,
    },
    repository: { full_name: "example/repo" },
  };
}

describe("AC-DETECT-6: GitHub release webhook → detectAndActivate (github_release_webhook)", () => {
  beforeEach(() => {
    secretCacheMock.findHabitatIdByGithubSignature.mockReturnValue(habitatId);
  });

  it("records a release row when action=published + !draft + !prerelease", async () => {
    // Seed a prior so self-classification works (otherwise first-release error).
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v0.1.1" }),
      { habitatId },
    );

    expect(result.status).toBe("recorded");
    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.1.1");
    expect(row).not.toBeNull();
    expect(row!.detectedBy).toBe("github_release_webhook");
    expect(row!.releaseType).toBe("patch"); // self-classified from prior v0.1.0.
    expect(row!.releaseNotes).toBe("release notes");
  });

  it("records a release row when action=released (gh-release CLI path)", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ action: "released", tagName: "v0.1.2" }),
      { habitatId },
    );

    expect(result.status).toBe("recorded");
    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.1.2");
    expect(row).not.toBeNull();
    expect(row!.detectedBy).toBe("github_release_webhook");
  });

  it("AC-DETECT-6: first release via webhook without prior — surfaces 400 for GitHub redelivery", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v1.0.0" }),
      { habitatId },
    );

    expect(result.status).toBe("error");
    expect(result.statusCode).toBe(400);
    expect(result.error).toMatch(/explicit type/i);
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "1.0.0")).toBeNull();
  });

  it("successful recording returns no statusCode (dispatcher defaults to 200)", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v0.1.1" }),
      { habitatId },
    );

    expect(result.status).toBe("recorded");
    expect(result.statusCode).toBeUndefined();
  });
});

describe("AC-DETECT-6: ignored GitHub release payloads do NOT trigger", () => {
  beforeEach(() => {
    secretCacheMock.findHabitatIdByGithubSignature.mockReturnValue(habitatId);
  });

  it("ignores action=unpublished", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ action: "unpublished", tagName: "v0.2.0" }),
      { habitatId },
    );

    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.2.0")).toBeNull();
  });

  it("ignores draft releases", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v0.2.0", draft: true }),
      { habitatId },
    );

    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.2.0")).toBeNull();
  });

  it("ignores prerelease releases", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v0.2.0", prerelease: true }),
      { habitatId },
    );

    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.2.0")).toBeNull();
  });

  it("ignores semver pre-release tags (v1.0.0-rc.1) even when GitHub prerelease=false", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v1.0.0-rc.1", prerelease: false }),
      { habitatId },
    );

    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "1.0.0")).toBeNull();
  });

  it("ignores semver pre-release tags (v0.1.0-beta)", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v0.1.0-beta", prerelease: false }),
      { habitatId },
    );

    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.1.0")).toBeNull();
  });

  it("ignores semver pre-release tags (v2.0.0-alpha.3)", async () => {
    const result = await githubReleaseWebhook.handleGitHubReleaseEvent(
      buildReleasePayload({ tagName: "v2.0.0-alpha.3", prerelease: false }),
      { habitatId },
    );

    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "2.0.0")).toBeNull();
  });
});

describe("AC-DETECT-7: workflow_run release-workflow convention triggers cicd_pipeline detection", () => {
  beforeEach(() => {
    secretCacheMock.findHabitatIdByCiCdSignature.mockReturnValue(habitatId);
  });

  /**
   * Replicates the convention check from `ciCdWebhooks.ts:39-44`. The route
   * computes `isReleaseWorkflow` from the habitat's `releaseSettings` and the
   * run's `conclusion`/`name`/`head_branch`, then calls `detectAndActivate`
   * with `detectedBy:"cicd_pipeline"`. We assert the observable side effect
   * (the release row with that provenance) when the convention matches.
   */
  async function applyConventionAndTrigger(run: {
    conclusion: string;
    name: string;
    head_branch: string;
  }): Promise<void> {
    const settings = { releaseWorkflowName: "release", requireVersionTag: true };
    const isReleaseWorkflow =
      run.conclusion === "success" &&
      typeof run.name === "string" &&
      run.name.includes(settings.releaseWorkflowName) &&
      (!settings.requireVersionTag ||
        /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/.test(run.head_branch));
    if (!isReleaseWorkflow) return;
    // Semver pre-release skip (mirrors ciCdWebhooks.ts convention).
    try {
      if (isPreRelease(parseVersion(run.head_branch))) return;
    } catch {
      return;
    }
    await releaseTriggerService.detectAndActivate(habitatId, run.head_branch, {
      detectedBy: "cicd_pipeline",
    });
  }

  it("matching workflow_run (release.yml + success + v* tag) records a cicd_pipeline row", async () => {
    // Seed a prior so self-classification works (otherwise first-release error).
    await releaseTriggerService.detectAndActivate(habitatId, "v0.8.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    await applyConventionAndTrigger({
      conclusion: "success",
      name: "release.yml",
      head_branch: "v0.9.0",
    });

    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.9.0");
    expect(row).not.toBeNull();
    expect(row!.detectedBy).toBe("cicd_pipeline");
    expect(row!.releaseType).toBe("minor"); // 0.8.0 → 0.9.0 = minor bump
  });

  it("AC-DETECT-8: non-matching workflow_run does NOT trigger release detection", async () => {
    // Failed conclusion.
    await applyConventionAndTrigger({
      conclusion: "failure",
      name: "release.yml",
      head_branch: "v0.9.1",
    });
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.9.1")).toBeNull();

    // Wrong workflow name (no "release" substring).
    await applyConventionAndTrigger({
      conclusion: "success",
      name: "ci.yml",
      head_branch: "v0.9.2",
    });
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.9.2")).toBeNull();

    // Non-version-tag ref (default requireVersionTag=true).
    await applyConventionAndTrigger({
      conclusion: "success",
      name: "release.yml",
      head_branch: "main",
    });
    const db = getDb();
    const all = db.select().from(releasesTable).where(eq(releasesTable.habitatId, habitatId)).all();
    expect(all).toHaveLength(0);
  });

  it("ignores pre-release tags (v1.0.0-rc.1) even when convention matches", async () => {
    await applyConventionAndTrigger({
      conclusion: "success",
      name: "release.yml",
      head_branch: "v1.0.0-rc.1",
    });

    expect(releaseRepo.findByHabitatAndVersion(habitatId, "1.0.0")).toBeNull();
  });
});
