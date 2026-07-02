/**
 * Release vocabulary for v0.24.0 "Cadence" (ADR-0029 / ADR-0030).
 *
 * `RELEASE_TYPES` is the canonical const array backing the cascading-type
 * matcher (semver engine) and the `target_release_type` column on
 * `finding_triage`. `DETECTOR_SOURCES` discriminates release-detection
 * provenance on the `releases` table. `ReleaseShippedPayload` is the
 * `release.shipped` automation-event data shape.
 */

/** Exhaustive readonly list of release types, ordered by ascending scope (patch ⊂ minor ⊂ major). */
export const RELEASE_TYPES = ["patch", "minor", "major"] as const;

/** Release type used for cascading-type matching and the `targetReleaseType` column. */
export type ReleaseType = (typeof RELEASE_TYPES)[number];

/** Exhaustive readonly list of release-detection provenance discriminators. */
export const DETECTOR_SOURCES = [
  "github_release_webhook",
  "cicd_pipeline",
  "cli",
  "external",
  "api",
] as const;

/** Provenance discriminator stamped on the `releases` row (`detected_by`). */
export type DetectorSource = (typeof DETECTOR_SOURCES)[number];

/** Data carried on the `release.shipped` automation event (ADR-0030). */
export interface ReleaseShippedPayload {
  releaseId: string;
  version: string;
  releaseType: ReleaseType;
  detectedBy: DetectorSource;
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
  erroredCount: number;
}
