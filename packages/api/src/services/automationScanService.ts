/**
 * CS-56 T5 — Scheduled scan cut-over + Habitat-scoped candidate repair.
 *
 * Each of the seven scan families now routes through the canonical lifecycle
 * ({@link attemptRuleRun}). Callers retain only candidate enumeration,
 * target/payload normalization, deterministic trigger-id minting, and
 * disposition-derived counters.
 *
 * Candidate queries
 * -----------------
 * - `listBlockedMissions(habitatId)` — non-archived missions with at least
 *   one `mission_dependencies` edge whose target Mission is present and
 *   `status !== "done"`. Matches `computeMissionSummary` semantics exactly.
 * - `listSilentAgentsInHabitat(habitatId, thresholdMinutes)` — non-offline
 *   Agents with `lastHeartbeat` older than the Habitat's
 *   `anomalySettings.thresholds.agentOfflineMinutes`, AND at least one
 *   `claimed`/`in_progress`/`submitted` Task in a Habitat-owned Mission.
 *   Global Agents without Habitat-scoped active work are excluded.
 * - `listActiveEvidenceGapsInHabitat(habitatId)` — active `codeEvidenceGaps`
 *   whose target resolves back to the Habitat via the Task→Mission chain
 *   (task target) or directly (mission target). Resolved, orphaned, and
 *   cross-Habitat gaps are excluded.
 *
 * Each scan emits one attempt per candidate per rule. Deterministic
 * synthetic trigger ids are `scan:{scanType}:{candidateId}:{habitatId}`.
 * Scan attempts retain `eventDedupeKey: null`; cooldown controls repeat
 * execution via the canonical lifecycle.
 *
 * Counter derivation (per the technical plan):
 *   - `executed`     → `rulesMatched`
 *   - `skipped`      → `rulesSkipped`
 *   - `deduplicated` → `rulesDeduplicated` (NEW — was misclassified)
 *   - `failed`       → recorded in `errors`
 *
 * The legacy `applyGuards` and `recordScanSkip` scan-owned lifecycle
 * helpers are removed; cooldown + hourly admission now live solely inside
 * the canonical lifecycle.
 */
import { and, eq, lt, ne, inArray, sql } from "drizzle-orm";
import * as ruleRepo from "../repositories/automationRule.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as sprintRepo from "../repositories/sprint.js";
import { getAnomalySettings } from "./anomalyService.js";
import { agents } from "../db/schema/agent.js";
import { codeEvidenceGaps } from "../db/schema/code-evidence.js";
import { missions, missionDependencies } from "../db/schema/habitat.js";
import { tasks } from "../db/schema/task.js";
import { getDb } from "../db/index.js";
import type { AutomationScanType, AutomationRule, AutomationTargetType } from "@orcy/shared";
import {
  attemptRuleRun,
  type AutomationAttemptDisposition,
} from "./automationAttemptLifecycle.js";
import { runSignalPatternClusteredScan } from "./triageScanService.js";
import { runAgentQualityDegradedScan } from "./agentQualityScanService.js";
import { runOrphanMissionUnmappedScan } from "./orphanScanService.js";

/** Result summary of one automation scan pass over a habitat's automation rules. */
export interface ScanReport {
  scanType: AutomationScanType;
  habitatId: string;
  rulesMatched: number;
  rulesSkipped: number;
  /** NEW (CS-56 T5): count of duplicate trusted deliveries whose reservation already owned a row. Always 0 for scans (they pass `eventDedupeKey: null`). */
  rulesDeduplicated: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Candidate query result shapes
// ---------------------------------------------------------------------------

export interface BlockedMissionCandidate {
  missionId: string;
  title: string;
  blockedBy: { missionId: string; title: string; status: string }[];
  blockedByCount: number;
}

export interface SilentAgentCandidate {
  agentId: string;
  name: string;
  lastHeartbeat: string;
  elapsedMinutes: number;
  thresholdMinutes: number;
  activeTaskIds: string[];
  activeTaskCount: number;
}

export interface EvidenceGapCandidate {
  gapId: string;
  targetType: "task" | "mission";
  targetId: string;
  reasonCode: string;
  reasonNote: string | null;
  reportedAt: string;
  activeGapCount: number;
}

/**
 * CS-56 cold-review M1 — Active-Task status set shared between the candidate
 * query (`listSilentAgentsInHabitat`) and the event/manual
 * `agentHasHabitatWork` signal. Both must agree on what counts as "active"
 * Habitat work; otherwise an Agent whose only open Task is `done`/`approved`
 * becomes a silent / Habitat-relevance candidate, weakening global-Agent ↔
 * Habitat isolation. The settled contract per the CS-56 technical plan is
 * `claimed | in_progress | submitted` — terminal statuses
 * (`done`/`approved`/`rejected`/`failed`) deliberately do NOT count.
 */
export const ACTIVE_TASK_STATUSES = ["claimed", "in_progress", "submitted"] as const;

// ---------------------------------------------------------------------------
// Dispatch helper — one deterministic synthetic trigger id per candidate
// ---------------------------------------------------------------------------

interface ScanCandidateDispatch {
  scanType: AutomationScanType;
  triggerEventId: string;
  targetType: AutomationTargetType;
  targetId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Routes one scan candidate through the canonical lifecycle. The
 * disposition is the sole basis for caller counters.
 */
async function dispatchScanCandidate(
  rule: AutomationRule,
  habitatId: string,
  candidate: ScanCandidateDispatch,
): Promise<AutomationAttemptDisposition> {
  return attemptRuleRun({
    rule,
    source: "scan",
    trigger: {
      triggerType: candidate.scanType,
      triggerEventId: candidate.triggerEventId,
      habitatId,
      targetType: candidate.targetType,
      targetId: candidate.targetId,
      payload: candidate.payload,
    },
    eventDedupeKey: null,
  });
}

/**
 * Counter accumulator shared between the event ingestion caller
 * ({@link automationEventService.ingestEvent}) and every scan family.
 *
 *  - `executed`         → `matched++`. When `outcome` is `"failed"` or
 *                          `"partial_failed"`, ALSO append a bounded error
 *                          (rule id + failing action indices/types from
 *                          `actionResults`) so callers can surface the
 *                          failure in the report's `errors` array while
 *                          still counting the attempt as executed.
 *  - `skipped`          → `skipped++`.
 *  - `deduplicated`     → `deduplicated++`.
 *  - `failed`           → append a `stage` error; matched is NOT incremented
 *                          (the attempt never reached actions).
 *
 * Exported so all callers (event + 7 scan families) route through one
 * implementation; otherwise the failure-surfacing rule (per the technical
 * plan's "Caller counters" table) and the matched-vs-error trade-off can
 * drift between callers — the same drift the cold review caught.
 */
export function tallyDisposition(
  rule: AutomationRule,
  disposition: AutomationAttemptDisposition,
  acc: { matched: number; skipped: number; deduplicated: number; errors: string[] },
): void {
  switch (disposition.kind) {
    case "executed":
      acc.matched++;
      if (disposition.outcome === "failed" || disposition.outcome === "partial_failed") {
        const failing = disposition.actionResults
          .map((r, idx) => ({ r, idx }))
          .filter(({ r }) => r.status === "failed");
        const summary = failing
          .map(({ r, idx }) => `${idx}:${r.actionType}${r.error ? `:${r.error}` : ""}`)
          .join(", ");
        acc.errors.push(
          `Rule ${rule.id}: actions ${disposition.outcome} (${summary || "no detail"})`,
        );
      }
      break;
    case "skipped":
      acc.skipped++;
      break;
    case "deduplicated":
      acc.deduplicated++;
      break;
    case "failed":
      acc.errors.push(
        `Rule ${rule.id}: ${disposition.stage === "condition" ? "condition" : "actions"} failed`,
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Candidate queries (Habitat-scoped)
// ---------------------------------------------------------------------------

/**
 * Enumerate every non-archived blocked Mission in the Habitat. Uses the
 * `mission_dependencies` join (authoritative — matches
 * `computeMissionSummary`). A Mission is blocked when at least one of its
 * dependency targets is PRESENT (not deleted) and `status !== "done"`;
 * archived targets participate, deleted targets do not synthesize a block.
 */
export function listBlockedMissions(habitatId: string): BlockedMissionCandidate[] {
  const db = getDb();
  // CS-56 cold-review m2 — unbounded call. The repository supports
  // omitting `limit` (it returns all matching missions + the unfiltered
  // `total`). Habitats with >1000 Missions must not silently miss blocked
  // candidates due to a hardcoded cap.
  const habitatMissions = missionRepo.getMissionsByHabitatId(habitatId, {
    isArchived: false,
  }).missions;
  if (habitatMissions.length === 0) return [];

  const sourceIds = habitatMissions.map((m) => m.id);
  const edges = missionRepo.getMissionDependencyEdges(sourceIds);
  if (edges.length === 0) return [];

  const targetIds = [...new Set(edges.map((e) => e.dependsOnId))];
  const targetRows = db
    .select({
      id: missions.id,
      title: missions.title,
      status: missions.status,
    })
    .from(missions)
    .where(inArray(missions.id, targetIds))
    .all();

  const targetById = new Map<string, { id: string; title: string; status: string }>();
  for (const t of targetRows) targetById.set(t.id, t);

  // Group edges by source so each source Mission visits its deps once.
  const edgesBySource = new Map<string, string[]>();
  for (const e of edges) {
    const list = edgesBySource.get(e.missionId);
    if (list) list.push(e.dependsOnId);
    else edgesBySource.set(e.missionId, [e.dependsOnId]);
  }

  const candidates: BlockedMissionCandidate[] = [];
  for (const source of habitatMissions) {
    const depIds = edgesBySource.get(source.id);
    if (!depIds || depIds.length === 0) continue;
    const blockers: { missionId: string; title: string; status: string }[] = [];
    for (const depId of depIds) {
      const dep = targetById.get(depId);
      // Deleted dependency targets do not synthesize a block.
      if (!dep) continue;
      // Done targets do not block.
      if (dep.status === "done") continue;
      blockers.push({ missionId: dep.id, title: dep.title, status: dep.status });
    }
    if (blockers.length === 0) continue;
    candidates.push({
      missionId: source.id,
      title: source.title,
      blockedBy: blockers,
      blockedByCount: blockers.length,
    });
  }
  return candidates;
}

/**
 * Enumerate silent Agents in the given Habitat. Mirrors the anomaly
 * detector's eligibility rule (non-offline + `lastHeartbeat` older than the
 * Habitat's configured `agentOfflineMinutes` threshold) but adds Habitat
 * relevance: the Agent must have at least one `claimed`/`in_progress`/
 * `submitted` Task in a Mission owned by the current Habitat. Global
 * Agents without Habitat-scoped active work are NOT candidates.
 *
 * `anomalySettings.thresholds.agentOfflineMinutes` is reused as the
 * silence threshold EVEN when anomaly notifications are disabled — the
 * Automation scan is Automation behavior, not an anomaly side-effect.
 */
export function listSilentAgentsInHabitat(
  habitatId: string,
  nowIso?: string,
): SilentAgentCandidate[] {
  const db = getDb();
  const now = nowIso ?? new Date().toISOString();
  const settings = getAnomalySettings(habitatId);
  const thresholdMinutes = settings.thresholds.agentOfflineMinutes;
  const threshold = new Date(
    new Date(now).getTime() - thresholdMinutes * 60 * 1000,
  ).toISOString();

  // Eligible agents: non-offline + heartbeat older than threshold.
  const eligibleAgents = db
    .select({
      id: agents.id,
      name: agents.name,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .where(and(lt(agents.lastHeartbeat, threshold), ne(agents.status, "offline")))
    .all();
  if (eligibleAgents.length === 0) return [];

  const agentIds = eligibleAgents.map((a) => a.id);

  // Active Habitat-scoped Tasks for these agents.
  const activeRows = db
    .select({
      taskId: tasks.id,
      assignedAgentId: tasks.assignedAgentId,
    })
    .from(tasks)
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(
      and(
        inArray(tasks.assignedAgentId, agentIds),
        inArray(tasks.status, ACTIVE_TASK_STATUSES),
        eq(missions.habitatId, habitatId),
      ),
    )
    .all();

  const tasksByAgent = new Map<string, string[]>();
  for (const row of activeRows) {
    const aid = row.assignedAgentId;
    if (!aid) continue;
    const list = tasksByAgent.get(aid);
    if (list) list.push(row.taskId);
    else tasksByAgent.set(aid, [row.taskId]);
  }

  const candidates: SilentAgentCandidate[] = [];
  for (const agent of eligibleAgents) {
    const taskIds = tasksByAgent.get(agent.id);
    if (!taskIds || taskIds.length === 0) continue;
    const elapsedMs = new Date(now).getTime() - new Date(agent.lastHeartbeat).getTime();
    candidates.push({
      agentId: agent.id,
      name: agent.name,
      lastHeartbeat: agent.lastHeartbeat,
      elapsedMinutes: Math.round(elapsedMs / 60000),
      thresholdMinutes,
      activeTaskIds: taskIds,
      activeTaskCount: taskIds.length,
    });
  }
  return candidates;
}

/**
 * Enumerate active evidence gaps whose target belongs to the given
 * Habitat. Resolved, orphaned (target deleted), and cross-Habitat rows
 * are excluded — the join to `tasks`/`missions` enforces Habitat
 * ownership at the SQL boundary.
 */
export function listActiveEvidenceGapsInHabitat(
  habitatId: string,
): EvidenceGapCandidate[] {
  const db = getDb();

  // For each active gap, resolve the target back to a Habitat:
  //   - targetType='task'    → join tasks.id → missions → habitatId
  //   - targetType='mission' → join missions.id → habitatId
  // Cross-Habitat rows are dropped by the WHERE; orphaned rows (deleted
  // target) collapse to no Habitat match and are likewise dropped.
  const rows = db
    .select({
      gap: codeEvidenceGaps,
    })
    .from(codeEvidenceGaps)
    .leftJoin(
      tasks,
      and(
        eq(codeEvidenceGaps.targetType, "task"),
        eq(tasks.id, codeEvidenceGaps.targetId),
      ),
    )
    .leftJoin(
      missions,
      sql`(${codeEvidenceGaps.targetType} = 'task' AND ${missions.id} = ${tasks.missionId})
          OR (${codeEvidenceGaps.targetType} = 'mission' AND ${missions.id} = ${codeEvidenceGaps.targetId})`,
    )
    .where(
      and(
        eq(codeEvidenceGaps.status, "active"),
        eq(missions.habitatId, habitatId),
      ),
    )
    .all();

  // Count active gaps per (targetType, targetId) for the `activeGapCount`
  // payload field. Each gap is enumerated as its own candidate attempt;
  // the count is metadata, not a dedupe.
  const countByKey = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.gap.targetType}:${row.gap.targetId}`;
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  }

  const candidates: EvidenceGapCandidate[] = rows.map((row) => {
    const key = `${row.gap.targetType}:${row.gap.targetId}`;
    return {
      gapId: row.gap.id,
      targetType: row.gap.targetType as "task" | "mission",
      targetId: row.gap.targetId,
      reasonCode: row.gap.reasonCode,
      reasonNote: row.gap.reasonNote,
      reportedAt: row.gap.reportedAt,
      activeGapCount: countByKey.get(key) ?? 1,
    };
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// Scan orchestrator — runs every scan family across every habitat
// ---------------------------------------------------------------------------

/** Runs every automation scan type across all habitats, returning a {@link ScanReport} per habitat-scan that matched any rules. */
export async function runAllScans(): Promise<ScanReport[]> {
  const reports: ScanReport[] = [];
  const habitats = habitatRepo.listHabitats();
  for (const h of habitats) {
    reports.push(...(await runMissionBlockedScan(h.id)));
    reports.push(...(await runSprintEndingScan(h.id)));
    reports.push(...(await runAgentSilentScan(h.id)));
    reports.push(...(await runEvidenceGapScan(h.id)));
    reports.push(...(await runSignalPatternClusteredScan(h.id)));
    reports.push(...(await runAgentQualityDegradedScan(h.id)));
    reports.push(...(await runOrphanMissionUnmappedScan(h.id)));
  }
  return reports;
}

/** Empty-report helper (no candidates + no enabled rules). */
function emptyReport(scanType: AutomationScanType, habitatId: string): ScanReport {
  return {
    scanType,
    habitatId,
    rulesMatched: 0,
    rulesSkipped: 0,
    rulesDeduplicated: 0,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Per-scan runners (cut over to attemptRuleRun in T5)
// ---------------------------------------------------------------------------

/**
 * `mission_blocked` — one attempt per actually-blocked Mission per rule.
 * No candidates → no attempts. Trigger ids are deterministic per candidate.
 */
async function runMissionBlockedScan(habitatId: string): Promise<ScanReport[]> {
  const scanType: AutomationScanType = "mission_blocked";
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  const candidates = listBlockedMissions(habitatId);
  if (rules.length === 0 || candidates.length === 0) {
    return [emptyReport(scanType, habitatId)];
  }

  const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };

  for (const candidate of candidates) {
    const triggerEventId = `scan:mission_blocked:${candidate.missionId}:${habitatId}`;
    const payload = {
      missionId: candidate.missionId,
      title: candidate.title,
      blockedBy: candidate.blockedBy,
      blockedByCount: candidate.blockedByCount,
    };
    for (const rule of rules) {
      try {
        const disposition = await dispatchScanCandidate(rule, habitatId, {
          scanType,
          triggerEventId,
          targetType: "mission",
          targetId: candidate.missionId,
          payload,
        });
        tallyDisposition(rule, disposition, acc);
      } catch (err) {
        acc.errors.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return [
    {
      scanType,
      habitatId,
      rulesMatched: acc.matched,
      rulesSkipped: acc.skipped,
      rulesDeduplicated: acc.deduplicated,
      errors: acc.errors,
    },
  ];
}

/**
 * `sprint_ending` — one attempt per active Sprint per rule. Target is the
 * active Sprint; payload carries the existing Sprint + raw facts (the
 * trigger is the Sprint itself, mirroring the pre-T5 target).
 */
async function runSprintEndingScan(habitatId: string): Promise<ScanReport[]> {
  const scanType: AutomationScanType = "sprint_ending";
  const sprints = sprintRepo.getByHabitatId(habitatId);
  const active = sprints.find((s) => s.status === "active");
  if (!active) return [];
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  if (rules.length === 0) return [emptyReport(scanType, habitatId)];

  const triggerEventId = `scan:sprint_ending:${active.id}:${habitatId}`;
  const payload = {
    sprintId: active.id,
    name: active.name,
    endDate: active.endDate,
    startDate: active.startDate,
  };

  const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };

  for (const rule of rules) {
    try {
      const disposition = await dispatchScanCandidate(rule, habitatId, {
        scanType,
        triggerEventId,
        targetType: "sprint",
        targetId: active.id,
        payload,
      });
      tallyDisposition(rule, disposition, acc);
    } catch (err) {
      acc.errors.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return [
    {
      scanType,
      habitatId,
      rulesMatched: acc.matched,
      rulesSkipped: acc.skipped,
      rulesDeduplicated: acc.deduplicated,
      errors: acc.errors,
    },
  ];
}

/**
 * `agent_silent` — one attempt per silent Agent (per Habitat) per rule.
 * Target is the Agent; payload carries heartbeat/elapsed/threshold +
 * active Task ids/count.
 */
async function runAgentSilentScan(habitatId: string): Promise<ScanReport[]> {
  const scanType: AutomationScanType = "agent_silent";
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  const candidates = listSilentAgentsInHabitat(habitatId);
  if (rules.length === 0 || candidates.length === 0) {
    return [emptyReport(scanType, habitatId)];
  }

  const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };

  for (const candidate of candidates) {
    const triggerEventId = `scan:agent_silent:${candidate.agentId}:${habitatId}`;
    const payload = {
      agentId: candidate.agentId,
      name: candidate.name,
      lastHeartbeat: candidate.lastHeartbeat,
      elapsedMinutes: candidate.elapsedMinutes,
      thresholdMinutes: candidate.thresholdMinutes,
      activeTaskIds: candidate.activeTaskIds,
      activeTaskCount: candidate.activeTaskCount,
    };
    for (const rule of rules) {
      try {
        const disposition = await dispatchScanCandidate(rule, habitatId, {
          scanType,
          triggerEventId,
          targetType: "agent",
          targetId: candidate.agentId,
          payload,
        });
        tallyDisposition(rule, disposition, acc);
      } catch (err) {
        acc.errors.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return [
    {
      scanType,
      habitatId,
      rulesMatched: acc.matched,
      rulesSkipped: acc.skipped,
      rulesDeduplicated: acc.deduplicated,
      errors: acc.errors,
    },
  ];
}

/**
 * `evidence_gap_open` — one attempt per active gap per rule. Target is the
 * gap's `task` or `mission` (whichever Habitat-scoped type the gap
 * references). Payload carries gap facts + the Habitat-scoped active-gap
 * count for that target.
 */
async function runEvidenceGapScan(habitatId: string): Promise<ScanReport[]> {
  const scanType: AutomationScanType = "evidence_gap_open";
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  const candidates = listActiveEvidenceGapsInHabitat(habitatId);
  if (rules.length === 0 || candidates.length === 0) {
    return [emptyReport(scanType, habitatId)];
  }

  const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };

  for (const candidate of candidates) {
    const triggerEventId = `scan:evidence_gap_open:${candidate.gapId}:${habitatId}`;
    const payload = {
      gapId: candidate.gapId,
      targetType: candidate.targetType,
      targetId: candidate.targetId,
      reasonCode: candidate.reasonCode,
      reasonNote: candidate.reasonNote,
      reportedAt: candidate.reportedAt,
      activeGapCount: candidate.activeGapCount,
    };
    for (const rule of rules) {
      try {
        const disposition = await dispatchScanCandidate(rule, habitatId, {
          scanType,
          triggerEventId,
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          payload,
        });
        tallyDisposition(rule, disposition, acc);
      } catch (err) {
        acc.errors.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return [
    {
      scanType,
      habitatId,
      rulesMatched: acc.matched,
      rulesSkipped: acc.skipped,
      rulesDeduplicated: acc.deduplicated,
      errors: acc.errors,
    },
  ];
}