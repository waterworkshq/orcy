/**
 * Restored Finding Triage lifecycle — inverse-mutation history guards (T5).
 *
 * Service-level guards that protect Finding evidence and work links against
 * destructive inverse mutations BEFORE the later FK `RESTRICT` enforcement
 * migration: referenced Pulses and linked Missions cannot be deleted, a
 * corrective Mission cannot be archived while a linked Finding is
 * non-terminal, and generic Mission gate edits cannot bypass activation.
 *
 * Placement note (hub asymmetry): these guards live at the service seam.
 * `pulseService` itself cannot host the Pulse guard — importing the triage
 * repository from `pulseService` closes an import cycle
 * (`pulseService → findingTriage repo → habitatSkillService → pulseService`),
 * so the Pulse delete route calls this module directly.
 *
 * See ADR-0048 and the restored lifecycle technical plan ("Mission/Pulse
 * inverse guards").
 */

import * as findingTriageRepo from "../repositories/findingTriage.js";
import type { FindingTriage } from "../repositories/findingTriage.js";
import { AppError } from "../errors.js";

/** True when the Finding is in a terminal (`resolved`/`wontfix`) state. */
function isTerminal(finding: FindingTriage): boolean {
  return finding.status === "resolved" || finding.status === "wontfix";
}

/**
 * Throws a 409-style actionable error when the Pulse is referenced as source
 * or corroborating evidence by ANY Finding — terminal or not. Checks the
 * authoritative `finding_triage_evidence` membership (every role: any
 * reference blocks deletion) plus the legacy `finding_triage.pulse_id` source
 * pointer that pre-evidence rows carry.
 */
export function assertPulseNotFindingEvidence(pulseId: string): void {
  const evidenceRefs = findingTriageRepo.listEvidenceReferencesForPulse(pulseId);
  const sourceRefs = findingTriageRepo.findBySourcePulseId(pulseId);
  const legacyCorroborating = findingTriageRepo.findByLegacyCorroboratingPulseId(pulseId);
  if (evidenceRefs.length === 0 && sourceRefs.length === 0 && legacyCorroborating.length === 0) {
    return;
  }

  const findingIds = new Set<string>();
  for (const ref of evidenceRefs) findingIds.add(ref.findingTriageId);
  for (const ref of sourceRefs) findingIds.add(ref.id);
  for (const ref of legacyCorroborating) findingIds.add(ref.id);

  throw new AppError(
    409,
    "PULSE_IS_LIFECYCLE_EVIDENCE",
    "Pulse is referenced as lifecycle evidence by one or more Finding triage records and cannot be deleted.",
    {
      pulseId,
      findingTriageIds: [...findingIds],
      evidenceRoles: [...new Set(evidenceRefs.map((ref) => ref.role))],
    },
  );
}

/** Finding links that reference a Mission, for the delete/archive guards. */
export interface MissionFindingLinks {
  /** Corrective work links (`correctiveMissionId`), any Finding state. */
  corrective: FindingTriage[];
  /** Bounded investigation links (`admittedByTriageMissionId`), any state. */
  investigation: FindingTriage[];
}

/** Collects every Finding link (corrective and investigation) for a Mission. */
export function findMissionFindingLinks(missionId: string): MissionFindingLinks {
  return {
    corrective: findingTriageRepo.findByTriageMissionId(missionId),
    investigation: findingTriageRepo.findByAdmittedByTriageMissionId(missionId),
  };
}

/** Result of the Mission deletion guard. */
export type MissionDeleteGuardResult =
  | { blocked: false }
  | {
      blocked: true;
      reason: "has_finding_links";
      links: MissionFindingLinks;
    };

/**
 * Mission deletion rejects ANY investigation or corrective Finding link —
 * terminal or not. Deletion erases history; archive is the reversible
 * alternative.
 */
export function guardMissionDelete(missionId: string): MissionDeleteGuardResult {
  const links = findMissionFindingLinks(missionId);
  if (links.corrective.length > 0 || links.investigation.length > 0) {
    return { blocked: true, reason: "has_finding_links", links };
  }
  return { blocked: false };
}

/** Result of the corrective Mission archive guard. */
export type MissionArchiveGuardResult =
  | { blocked: false }
  | {
      blocked: true;
      reason: "has_non_terminal_finding_links";
      nonTerminalFindingIds: string[];
    };

/**
 * Archiving a corrective Mission rejects while ANY linked Finding is
 * non-terminal. Once every corrective link is terminal, archive is allowed
 * and the link stays queryable.
 */
export function guardCorrectiveMissionArchive(missionId: string): MissionArchiveGuardResult {
  const links = findMissionFindingLinks(missionId);
  const nonTerminal = links.corrective.filter((f) => !isTerminal(f));
  if (nonTerminal.length > 0) {
    return {
      blocked: true,
      reason: "has_non_terminal_finding_links",
      nonTerminalFindingIds: nonTerminal.map((f) => f.id),
    };
  }
  return { blocked: false };
}

/** Result of the generic Mission gate-edit guard. */
export type MissionGateEditGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "gate_clear_blocked" | "gate_change_blocked";
      /** Finding ids whose state blocks the edit. */
      findingIds: string[];
    };

/**
 * The effective Mission release gate — both dimensions. A gate is PRESENT
 * when either dimension is non-null (mirrors the release-gate satisfaction
 * check in `@orcy/shared/semver`).
 */
export interface MissionGateSnapshot {
  releaseGateType: "patch" | "minor" | "major" | null;
  releaseGateVersion: string | null;
}

/**
 * Generic Mission update gate rules (activation owns gate clearing):
 *
 * - CLEARING the effective gate (either dimension non-null → both null)
 *   while any linked Finding is non-terminal is rejected — humans are
 *   directed to activation, which clears the gate and activates the group
 *   atomically.
 * - ADDING/REPLACING any gate dimension while any linked Finding is
 *   `in_progress` is rejected — including version-only additions and
 *   same-type-new-version replacements (a future reroute command may
 *   define this).
 * - Non-null-to-non-null gate changes and dependency edits remain ordinary
 *   versioned Mission edits while the linked Findings are `triaged`.
 *
 * `current` is the Mission's live `{type, version}` gate BEFORE the edit;
 * each `next` field is the incoming value from the update payload
 * (undefined = untouched — the current value carries over).
 */
export function guardMissionGateEdit(
  missionId: string,
  current: MissionGateSnapshot,
  next: {
    releaseGateType?: "patch" | "minor" | "major" | null;
    releaseGateVersion?: string | null;
  },
): MissionGateEditGuardResult {
  const typeTouched = next.releaseGateType !== undefined;
  const versionTouched = next.releaseGateVersion !== undefined;
  if (!typeTouched && !versionTouched) return { allowed: true };

  // Effective AFTER gate: touched fields from the payload, untouched fields
  // carried over from the live Mission.
  const afterType = typeTouched ? next.releaseGateType! : current.releaseGateType;
  const afterVersion = versionTouched ? next.releaseGateVersion! : current.releaseGateVersion;

  const beforePresent = current.releaseGateType !== null || current.releaseGateVersion !== null;
  const afterPresent = afterType !== null || afterVersion !== null;

  const linked = findingTriageRepo.findByTriageMissionId(missionId);

  // CLEAR: effective gate removed while any linked Finding is non-terminal.
  if (beforePresent && !afterPresent) {
    const blocking = linked.filter((f) => !isTerminal(f));
    if (blocking.length > 0) {
      return {
        allowed: false,
        reason: "gate_clear_blocked",
        findingIds: blocking.map((f) => f.id),
      };
    }
    return { allowed: true };
  }

  // ADD (absent → present) or REPLACE (present → different present) in ANY
  // dimension — including version-only additions and same-type-new-version
  // replacements — while any linked Finding is in_progress.
  if (
    afterPresent &&
    (afterType !== current.releaseGateType || afterVersion !== current.releaseGateVersion)
  ) {
    const blocking = linked.filter((f) => f.status === "in_progress");
    if (blocking.length > 0) {
      return {
        allowed: false,
        reason: "gate_change_blocked",
        findingIds: blocking.map((f) => f.id),
      };
    }
  }

  return { allowed: true };
}
