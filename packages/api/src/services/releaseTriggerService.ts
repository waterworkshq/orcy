import * as releaseRepo from "../repositories/release.js";
import type { Release } from "../repositories/release.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as featureService from "./featureService.js";
import * as releaseSettingsService from "./releaseSettingsService.js";
import { ingestEvent } from "./automationEventService.js";
import { enqueueNotification } from "./notificationCommandService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { RepositoryError } from "../errors/repository.js";
import { isSqliteError } from "../errors/sqlite.js";
import { badRequest, AppError } from "../errors.js";
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

interface ActivationCounts {
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
}

/**
 * Detects a release, classifies its type, records the `releases` row, and runs
 * the activation loop (ADR-0030 / ADR-0031). The single orchestration seam
 * converging all detectors: GitHub release webhook, CI/CD pipeline completion,
 * CLI, and the provider-agnostic REST endpoint.
 *
 * Flow: normalise version → idempotency check → classify (caller-override or
 * semver-diff against the most recent prior row; first release requires an
 * explicit type) → record → activation gate → matched-finding promotion loop →
 * batched notification → retrospective pulse → `release.shipped` event.
 *
 * Idempotent on `(habitatId, version)`: a duplicate webhook re-delivery hits
 * the existing row and no-ops before any side effect. A concurrent same-version
 * webhook that wins the UNIQUE race between the pre-check and the insert is
 * caught and treated as a no-op too. The two-layer kill switch
 * (`ORCY_RELEASE_AUTO_PROMOTE` env AND habitat `releaseSettings.autoPromote`)
 * gates ONLY the promotion loop; detection, recording, the retrospective pulse,
 * and the `release.shipped` event always run (PRD AC-ACTIVATE-8).
 */
export async function detectAndActivate(
  habitatId: string,
  version: string,
  opts: { releaseType?: ReleaseType; detectedBy: DetectorSource; releaseNotes?: string },
): Promise<DetectAndActivateResult> {
  const noop = (release: Release): DetectAndActivateResult => ({
    release,
    promotedCount: 0,
    createdMissionCount: 0,
    skippedCount: 0,
  });

  const finish = (release: Release, counts: ActivationCounts): DetectAndActivateResult => ({
    release,
    ...counts,
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

  // --- Activation loop (ADR-0031: unconditional, no human gate) ---
  let promotedCount = 0;
  let createdMissionCount = 0;
  let skippedCount = 0;

  if (releaseSettingsService.isAutoPromoteEnabled(habitatId)) {
    const matched = findingTriageRepo.findReleaseMatched(
      habitatId,
      release.releaseType,
      release.version,
    );

    for (const finding of matched) {
      try {
        findingTriageRepo.promote(finding.id, { type: "system", id: "release" });
      } catch (err) {
        if (err instanceof AppError && err.code === "CONFLICT") {
          skippedCount++;
          continue;
        }
        throw err;
      }
      promotedCount++;

      const pulse = pulseRepo.getPulseById(finding.pulseId);
      const title = `Corrective: ${pulse?.subject ?? finding.clusterKey}`;
      const description = [
        "## Finding Triage",
        `- Cluster: ${finding.clusterKey}`,
        `- Kind: ${finding.findingKind}`,
        `- Bucket: ${finding.bucket ?? "—"}`,
        `- Finding triage id: ${finding.id}`,
        "",
        "## Source Pulse",
        pulse?.body ?? "—",
        "",
        "## Task",
        "Address the deferred finding captured in the source pulse. Resolve or document and close the triage record.",
      ].join("\n");

      const mission = featureService.createMission({
        habitatId,
        title,
        description,
        labels: ["triage", finding.findingKind],
        createdBy: "release",
      });
      createdMissionCount++;

      try {
        findingTriageRepo.setTriageMissionId(finding.id, mission.id);
      } catch {
        // Mission created but back-link failed — non-critical (mirror manual promote route).
      }

      sseBroadcaster.publish(habitatId, {
        type: "triage.finding_updated",
        data: {
          habitatId,
          findingId: finding.id,
          status: "in_progress",
          bucket: finding.bucket,
        },
      });
    }
  }

  if (promotedCount > 0) {
    enqueueNotification({
      habitatId,
      eventType: "release.activated",
      sourceType: "system",
      sourceId: release.id,
      severity: "info",
      payload: {
        releaseId: release.id,
        version: release.version,
        releaseType: release.releaseType,
        promotedCount,
      },
      createdByType: "system",
      createdById: "release",
    });
  }

  const retrospectiveBody = [
    `Release ${release.version} (${release.releaseType}) shipped via ${release.detectedBy}.`,
    `- Promoted findings: ${promotedCount}`,
    `- Corrective missions created: ${createdMissionCount}`,
    `- Skipped (already in progress): ${skippedCount}`,
  ].join("\n");
  pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    signalType: "context",
    fromType: "system",
    fromId: "release",
    subject: `Release ${release.version} (${release.releaseType}) shipped`,
    body: retrospectiveBody,
    metadata: {
      releaseRetrospective: true,
      releaseId: release.id,
      version: release.version,
      releaseType: release.releaseType,
      detectedBy: release.detectedBy,
      promotedCount,
      createdMissionCount,
      skippedCount,
    },
  });

  await ingestEvent(habitatId, {
    type: "release.shipped",
    data: {
      eventId: release.id,
      releaseId: release.id,
      version: release.version,
      releaseType: release.releaseType,
      detectedBy: release.detectedBy,
      promotedCount,
      createdMissionCount,
      skippedCount,
    },
  });

  return finish(release, { promotedCount, createdMissionCount, skippedCount });
}
