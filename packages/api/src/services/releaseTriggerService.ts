/**
 * Release trigger service — the single orchestration seam converging every
 * Release detector (ADR-0030 / ADR-0031): the GitHub release webhook, the
 * CI/CD release-workflow convention, the CLI, and the provider-agnostic REST
 * endpoint all call {@link detectAndActivate} and NOTHING else.
 *
 * Since the restored lifecycle (T7) the one-shot processing chain is
 * replaced by durable reconciliation: the seam atomically create-or-loads
 * the Release row, ONE immutable activation epoch (frozen Finding-count cap,
 * deterministic eligible Mission groups, exact Finding membership, and an
 * eligibility digest), and the five pending projection rows
 * (`bootstrapReleaseWithEpoch`), then drives the ordered projection pass
 * (`reconcileReleaseProjections`): activation reconciliation → deadline
 * notification → activation notification → retrospective Pulse →
 * `release.shipped` handoff to the durable Automation inbox.
 *
 * Idempotent on `(habitatId, version)`: a duplicate delivery replays from
 * durable state — completed projections are skipped without duplicate
 * targets; pending projections resume. The result exposes incomplete
 * projection kinds rather than claiming a fully processed Release.
 * Pre-cutover Releases (created before T7, already processed by the retired
 * one-shot chain) carry no epoch and replay as no-ops.
 *
 * The two-layer kill switch (`ORCY_RELEASE_AUTO_PROMOTE` env AND habitat
 * `releaseSettings.autoPromote`) gates ONLY the activation loop — it is
 * frozen into the epoch at Release creation; detection, recording, the
 * retrospective pulse, and the `release.shipped` event always run
 * (PRD AC-ACTIVATE-8).
 */
import type { Release } from "../repositories/release.js";
import type { ReleaseProjectionKind } from "../db/schema/index.js";
import {
  bootstrapReleaseWithEpoch,
  reconcileReleaseProjections,
} from "./releaseReconciliationService.js";
import { badRequest } from "../errors.js";
import { parseVersion, type ReleaseType, type DetectorSource } from "@orcy/shared";

/** Result of a detect+activate run. */
export interface DetectAndActivateResult {
  release: Release;
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
  erroredCount: number;
  missedDeadlineCount: number;
  cappedCount: number;
  /**
   * Projection kinds still pending after this run (a replay resumes them);
   * empty means every projection completed. Never claims full processing
   * while a projection is incomplete.
   */
  incompleteProjections: ReleaseProjectionKind[];
}

/**
 * Detects a release, classifies its type, and drives durable per-projection
 * reconciliation over one immutable activation epoch. The single
 * orchestration seam converging all detectors.
 *
 * Flow: normalise version → atomic create-or-load (Release + epoch + pending
 * projections) → ordered projection pass (activation reconciliation under
 * locked per-group transactions with the frozen cap, deadline + activation
 * notifications, retrospective pulse, `release.shipped` inbox handoff).
 */
export async function detectAndActivate(
  habitatId: string,
  version: string,
  opts: { releaseType?: ReleaseType; detectedBy: DetectorSource; releaseNotes?: string },
): Promise<DetectAndActivateResult> {
  let parsed;
  try {
    parsed = parseVersion(version);
  } catch {
    throw badRequest("Invalid version");
  }
  const normalizedVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;

  const bootstrap = bootstrapReleaseWithEpoch(habitatId, normalizedVersion, opts);

  if (bootstrap.status === "legacy") {
    // Pre-cutover Release: the retired one-shot chain already processed it.
    return {
      release: bootstrap.release,
      promotedCount: 0,
      createdMissionCount: 0,
      skippedCount: 0,
      erroredCount: 0,
      missedDeadlineCount: 0,
      cappedCount: 0,
      incompleteProjections: [],
    };
  }

  const summary = await reconcileReleaseProjections(bootstrap.release);
  return {
    release: bootstrap.release,
    promotedCount: summary.promotedCount,
    createdMissionCount: summary.createdMissionCount,
    skippedCount: summary.skippedCount,
    erroredCount: summary.erroredCount,
    missedDeadlineCount: summary.missedDeadlineCount,
    cappedCount: summary.cappedCount,
    incompleteProjections: summary.incompleteProjections,
  };
}
