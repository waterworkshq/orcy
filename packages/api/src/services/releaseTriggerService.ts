import * as releaseRepo from "../repositories/release.js";
import type { Release } from "../repositories/release.js";
import { RepositoryError } from "../errors/repository.js";
import { isSqliteError } from "../errors/sqlite.js";
import { badRequest } from "../errors.js";
import {
  parseVersion,
  classifyReleaseType,
  type ReleaseType,
  type DetectorSource,
} from "@orcy/shared";

/** Result of a detect+activate run. Phase 2 returns zero activation counts (stubbed — Phase 3 widens). */
export interface DetectAndActivateResult {
  release: Release;
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
}

/**
 * Detects a release, classifies its type, and records the `releases` row
 * (ADR-0030). The single orchestration seam converging all detectors: GitHub
 * release webhook, CI/CD pipeline completion, CLI, and the provider-agnostic
 * REST endpoint.
 *
 * Flow: normalise version → idempotency check → classify (caller-override or
 * semver-diff against the most recent prior row; first release requires an
 * explicit type) → record. **Phase 2 stubs activation** (the promote loop,
 * retrospective pulse, and `release.shipped` event land in Phase 3); the
 * returned counts are always zero for a fresh record.
 *
 * Idempotent on `(habitatId, version)`: a duplicate webhook re-delivery hits
 * the existing row and no-ops before any side effect. A concurrent same-version
 * webhook that wins the UNIQUE race between the pre-check and the insert is
 * caught and treated as a no-op too.
 */
export function detectAndActivate(
  habitatId: string,
  version: string,
  opts: { releaseType?: ReleaseType; detectedBy: DetectorSource; releaseNotes?: string },
): DetectAndActivateResult {
  const noop = (release: Release): DetectAndActivateResult => ({
    release,
    promotedCount: 0,
    createdMissionCount: 0,
    skippedCount: 0,
  });

  let parsed;
  try {
    parsed = parseVersion(version);
  } catch {
    throw badRequest("Invalid version");
  }
  const normalizedVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;

  const existing = releaseRepo.findByHabitatAndVersion(habitatId, normalizedVersion);
  if (existing) return noop(existing);

  let releaseType: ReleaseType;
  let classificationMethod: "caller" | "self";
  if (opts.releaseType) {
    releaseType = opts.releaseType;
    classificationMethod = "caller";
  } else {
    const prior = releaseRepo.findMostRecentPrior(habitatId);
    if (!prior) {
      throw badRequest("First detected release requires an explicit type");
    }
    releaseType = classifyReleaseType(parseVersion(prior.version), parsed);
    classificationMethod = "self";
  }

  let release: Release;
  try {
    release = releaseRepo.create({
      habitatId,
      version: normalizedVersion,
      releaseType,
      detectedBy: opts.detectedBy,
      releaseNotes: opts.releaseNotes,
      metadata: { classificationMethod },
    });
  } catch (err) {
    const cause = err instanceof RepositoryError ? err.cause : err;
    const isUniqueViolation =
      (isSqliteError(cause) && cause.code === "SQLITE_CONSTRAINT_UNIQUE") ||
      (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message));
    if (isUniqueViolation) {
      const refetched = releaseRepo.findByHabitatAndVersion(habitatId, normalizedVersion);
      if (refetched) return noop(refetched);
    }
    throw err;
  }

  // Activation is stubbed for Phase 2. Phase 3 extends this with the promote
  // loop, retrospective pulse, and `release.shipped` automation event.
  return noop(release);
}
