import * as releaseRepo from "../repositories/release.js";
import type { Release } from "../repositories/release.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as releaseSettingsService from "./releaseSettingsService.js";
import { ingestEvent } from "./automationEventService.js";
import { enqueueNotificationForRecipients } from "./notificationCommandService.js";
import * as habitatRepo from "../repositories/board.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { RepositoryError } from "../errors/repository.js";
import { isSqliteError } from "../errors/sqlite.js";
import { badRequest, AppError } from "../errors.js";
import { eq, and, or, isNotNull, ne } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { missions } from "../db/schema/index.js";
import {
  parseVersion,
  classifyReleaseType,
  isReleaseGateSatisfied,
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
  missedDeadlineCount: number;
}

interface ActivationCounts {
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
  erroredCount: number;
  missedDeadlineCount: number;
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

/** Finds missions with release-gates that match the shipped release. */
function findGatedMissionsMatching(
  habitatId: string,
  shippedType: ReleaseType,
  shippedVersion: string,
): (typeof missions.$inferSelect)[] {
  const db = getDb();
  const gated = db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.habitatId, habitatId),
        eq(missions.status, "not_started"),
        or(isNotNull(missions.releaseGateType), isNotNull(missions.releaseGateVersion)),
      ),
    )
    .all();
  return gated.filter((m) =>
    isReleaseGateSatisfied(
      { releaseGateType: m.releaseGateType, releaseGateVersion: m.releaseGateVersion },
      new Set([shippedType]),
      [shippedVersion],
    ),
  );
}

/**
 * Finds missions with a release-deadline matching the shipped release that are
 * NOT done — i.e. missions that missed their deadline (RM-1). The deadline does
 * NOT block claiming; these missions escalate on miss (notification + retrospective).
 * Reuses {@link isReleaseGateSatisfied} (generic "does the shipped release match the
 * target?") on the deadline fields — only the consequence differs from the gate path.
 */
function findDeadlineMissedMissions(
  habitatId: string,
  shippedType: ReleaseType,
  shippedVersion: string,
): (typeof missions.$inferSelect)[] {
  const db = getDb();
  const withDeadline = db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.habitatId, habitatId),
        ne(missions.status, "done"),
        or(isNotNull(missions.releaseDeadlineType), isNotNull(missions.releaseDeadlineVersion)),
      ),
    )
    .all();
  return withDeadline.filter((m) =>
    isReleaseGateSatisfied(
      { releaseGateType: m.releaseDeadlineType, releaseGateVersion: m.releaseDeadlineVersion },
      new Set([shippedType]),
      [shippedVersion],
    ),
  );
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
    missedDeadlineCount: 0,
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

  // --- Gate resolution (ADR-0032: release-gates on missions resolve on release ship) ---
  // Runs BEFORE the legacy finding-promotion loop so the legacy loop's CONFLICT
  // guard naturally skips findings already promoted here.
  let activatedMissionCount = 0;

  if (releaseSettingsService.isAutoPromoteEnabled(habitatId)) {
    const gatedMissions = findGatedMissionsMatching(
      habitatId,
      release.releaseType,
      release.version,
    );

    for (const mission of gatedMissions) {
      try {
        const linkedFindings = findingTriageRepo.findByTriageMissionId(mission.id);
        for (const linkedFinding of linkedFindings) {
          if (linkedFinding.status !== "triaged") continue;
          try {
            findingTriageRepo.promote(linkedFinding.id, { type: "system", id: "release" });
          } catch (err) {
            if (err instanceof AppError && err.code === "CONFLICT") continue;
            throw err;
          }
          activatedMissionCount++;

          sseBroadcaster.publish(habitatId, {
            type: "triage.finding_updated",
            data: {
              habitatId,
              findingId: linkedFinding.id,
              status: "in_progress",
              bucket: linkedFinding.bucket,
            },
          });
        }
      } catch (err) {
        console.warn(
          `[release] gate-resolution error for mission ${mission.id} on ${release.version}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // RM-12: the legacy free-floating `findReleaseMatched` activation loop was
  // removed — release-gate resolution above is now the sole activation path
  // (ADR-0032). The promote/createMission/SSE side effects of that loop are
  // already covered by the gate-resolution path: linked findings promote there,
  // and corrective missions are created up-front by the triage insertion flow
  // (or the human authoring path), not at release time. `promotedCount`/
  // `createdMissionCount`/`skippedCount`/`erroredCount` stay 0 and remain in the
  // result contract + retrospective for backward compatibility.

  // --- Deadline escalation (RM-1: "before" release-deadline, enforcement-on-miss) ---
  // A mission whose release-deadline matches the shipped release AND is not yet
  // done missed its deadline. Escalate to habitat humans + record in the
  // retrospective. NOT gated by isAutoPromoteEnabled (this is a notification
  // concern, not promotion) and does NOT block claiming — a missed deadline is a
  // signal, not a hard stop, so the mission can still be completed late.
  const missedMissions = findDeadlineMissedMissions(
    habitatId,
    release.releaseType,
    release.version,
  );
  const missedDeadlineCount = missedMissions.length;

  if (missedDeadlineCount > 0) {
    const recipients = getHabitatHumanRecipients(habitatId);
    enqueueNotificationForRecipients(
      habitatId,
      "release.deadline_missed",
      "system",
      "warning",
      recipients,
      {
        sourceId: release.id,
        payload: {
          releaseId: release.id,
          version: release.version,
          releaseType: release.releaseType,
          missedDeadlineCount,
          missionIds: missedMissions.map((m) => m.id),
        },
        createdByType: "system",
        createdById: "release",
      },
    );
  }

  if (promotedCount > 0 || activatedMissionCount > 0) {
    // Recipients = human habitat members (team members for team habitats).
    // The notification resolver is explicit-recipient-based; habitat-default
    // subscriptions configure channels/cadence but do not enumerate recipients,
    // so the team membership must be sourced here (mirrors review assignment).
    // Always enqueue — the event row is created even with zero recipients, so
    // the notification log records the activation for personal habitats too.
    const recipients = getHabitatHumanRecipients(habitatId);
    enqueueNotificationForRecipients(habitatId, "release.activated", "system", "info", recipients, {
      sourceId: release.id,
      payload: {
        releaseId: release.id,
        version: release.version,
        releaseType: release.releaseType,
        promotedCount,
        activatedMissionCount,
      },
      createdByType: "system",
      createdById: "release",
    });
  }

  const retrospectiveBody = [
    `Release ${release.version} (${release.releaseType}) shipped via ${release.detectedBy}.`,
    `- Promoted findings: ${promotedCount}`,
    `- Gates resolved (missions activated): ${activatedMissionCount}`,
    `- Corrective missions created: ${createdMissionCount}`,
    `- Skipped (already in progress): ${skippedCount}`,
    `- Errored (promoted but mission failed): ${erroredCount}`,
    `- Deadlines missed (mission not done when its deadline release shipped): ${missedDeadlineCount}`,
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
      activatedMissionCount,
      createdMissionCount,
      skippedCount,
      erroredCount,
      missedDeadlineCount,
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
      activatedMissionCount,
      createdMissionCount,
      skippedCount,
      erroredCount,
      missedDeadlineCount,
    },
  });

  return finish(release, {
    promotedCount,
    createdMissionCount,
    skippedCount,
    erroredCount,
    missedDeadlineCount,
  });
}
