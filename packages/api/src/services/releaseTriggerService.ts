import * as releaseRepo from "../repositories/release.js";
import type { Release } from "../repositories/release.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as featureService from "./featureService.js";
import * as releaseSettingsService from "./releaseSettingsService.js";
import { ingestEvent } from "./automationEventService.js";
import { enqueueNotificationForRecipients } from "./notificationCommandService.js";
import * as habitatRepo from "../repositories/board.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
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

/** Result of a detect+activate run. */
export interface DetectAndActivateResult {
  release: Release;
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
  erroredCount: number;
}

interface ActivationCounts {
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
  erroredCount: number;
}

/** Resolves the human recipients for a habitat's release notification (team members). Returns [] for habitats without a team. */
function getHabitatHumanRecipients(
  habitatId: string,
): Array<{ recipientType: "human"; recipientId: string }> {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat?.teamId) return [];
  return teamMemberRepo.listMembers(habitat.teamId).map((m) => ({
    recipientType: "human" as const,
    recipientId: m.userId,
  }));
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
    erroredCount: 0,
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
    const prior = releaseRepo.findMostRecentPrior(habitatId, normalizedVersion);
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
  // Per-finding isolation: a non-CONFLICT throw on finding N is counted as
  // errored and the loop continues, so a mid-batch failure never orphans the
  // remaining findings or skips the retrospective/event (which run after).
  let promotedCount = 0;
  let createdMissionCount = 0;
  let skippedCount = 0;
  let erroredCount = 0;

  if (releaseSettingsService.isAutoPromoteEnabled(habitatId)) {
    const matched = findingTriageRepo.findReleaseMatched(
      habitatId,
      release.releaseType,
      release.version,
    );

    for (const finding of matched) {
      try {
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
      } catch (err) {
        // Per-finding isolation: a non-CONFLICT failure (e.g. createMission
        // throw) must not abort the batch. The finding may already be promoted
        // (triaged→in_progress); count it as errored and continue so the
        // remaining findings, the retrospective, and the event still run.
        erroredCount++;
        console.warn(
          `[release] activation error for finding ${finding.id} on ${release.version}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  if (promotedCount > 0) {
    // Recipients = human habitat members (team members for team habitats).
    // The notification resolver is explicit-recipient-based; habitat-default
    // subscriptions configure channels/cadence but do not enumerate recipients,
    // so the team membership must be sourced here (mirrors review assignment).
    const recipients = getHabitatHumanRecipients(habitatId);
    if (recipients.length > 0) {
      enqueueNotificationForRecipients(
        habitatId,
        "release.activated",
        "system",
        "info",
        recipients,
        {
          sourceId: release.id,
          payload: {
            releaseId: release.id,
            version: release.version,
            releaseType: release.releaseType,
            promotedCount,
          },
          createdByType: "system",
          createdById: "release",
        },
      );
    }
  }

  const retrospectiveBody = [
    `Release ${release.version} (${release.releaseType}) shipped via ${release.detectedBy}.`,
    `- Promoted findings: ${promotedCount}`,
    `- Corrective missions created: ${createdMissionCount}`,
    `- Skipped (already in progress): ${skippedCount}`,
    `- Errored (promoted but mission failed): ${erroredCount}`,
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
      erroredCount,
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
      erroredCount,
    },
  });

  return finish(release, { promotedCount, createdMissionCount, skippedCount, erroredCount });
}
