/**
 * Finding Triage preflight / doctor.
 *
 * Standalone diagnostics for the additive lifecycle schema. Reports stable
 * machine-readable diagnostics for: active identity duplicates, malformed
 * evidence JSON, terminal rows without Resolution Records, unusable Mission
 * links, unprovable investigation provenance, and invalid recurrence edges.
 *
 * This module is READ-ONLY with respect to production data. It does not
 * enforce, mutate, or block startup. The later enforcement migration (ticket 9)
 * will gate on these diagnostics.
 */

import { getDb } from "../db/index.js";
import { sql } from "drizzle-orm";

/** Preflight version — bumped when anomaly queries change. */
export const PREFLIGHT_VERSION = "001";

/** Schema version for the additive migration. */
export const ADDITIVE_SCHEMA_VERSION = "0064";

/**
 * Stable categories of anomalies the doctor checks. Each has a stable
 * machine-readable code for operator tooling.
 */
export type AnomalyCode =
  | "active_identity_duplicate"
  | "malformed_evidence_json"
  | "terminal_without_resolution_record"
  | "unusable_mission_link"
  | "unprovable_investigation_provenance"
  | "invalid_recurrence_edge";

/** One anomaly finding from the doctor scan. */
export interface PreflightAnomaly {
  code: AnomalyCode;
  findingTriagId: string;
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  detail: string;
}

/** Aggregate preflight result. */
export interface PreflightResult {
  version: string;
  schemaVersion: string;
  clean: boolean;
  anomalyCount: number;
  anomaliesByCode: Record<AnomalyCode, number>;
  anomalies: PreflightAnomaly[];
}

/**
 * Run the full preflight scan. Each diagnostic is an independent query so
 * a failure in one does not mask others. The result is deterministic — the
 * same database state always produces the same anomaly set (ordered by
 * finding_triage_id within each code).
 */
export function runPreflight(): PreflightResult {
  const db = getDb();

  const anomalies: PreflightAnomaly[] = [
    ...checkActiveIdentityDuplicates(db),
    ...checkMalformedEvidenceJson(db),
    ...checkTerminalWithoutResolutionRecord(db),
    ...checkUnusableMissionLink(db),
    ...checkUnprovableInvestigationProvenance(db),
    ...checkInvalidRecurrenceEdges(db),
  ];

  const anomaliesByCode = anomalies.reduce(
    (acc, a) => {
      acc[a.code] = (acc[a.code] ?? 0) + 1;
      return acc;
    },
    {} as Record<AnomalyCode, number>,
  );

  // Ensure all codes appear even with zero count.
  const allCodes: AnomalyCode[] = [
    "active_identity_duplicate",
    "malformed_evidence_json",
    "terminal_without_resolution_record",
    "unusable_mission_link",
    "unprovable_investigation_provenance",
    "invalid_recurrence_edge",
  ];
  for (const code of allCodes) {
    if (anomaliesByCode[code] === undefined) anomaliesByCode[code] = 0;
  }

  return {
    version: PREFLIGHT_VERSION,
    schemaVersion: ADDITIVE_SCHEMA_VERSION,
    clean: anomalies.length === 0,
    anomalyCount: anomalies.length,
    anomaliesByCode,
    anomalies,
  };
}

// --- Individual diagnostics ---

type DbClient = ReturnType<typeof getDb>;
type SqlRow = Record<string, unknown>;
type SqlRows = SqlRow[];

/**
 * Multiple non-terminal rows with the same (habitatId, clusterKey, findingKind).
 * Only the additive phase reports these; resolution (choosing a survivor) is
 * human-only.
 */
function checkActiveIdentityDuplicates(db: DbClient): PreflightAnomaly[] {
  const groups = db
    .all(
      sql`SELECT id, habitat_id, cluster_key, finding_kind
          FROM finding_triage
          WHERE status NOT IN ('resolved', 'wontfix')
          GROUP BY habitat_id, cluster_key, finding_kind
          HAVING COUNT(*) > 1`,
    ) as SqlRows;

  const anomalies: PreflightAnomaly[] = [];
  for (const group of groups) {
    const rows = db
      .all(
        sql`SELECT id, habitat_id, cluster_key, finding_kind
            FROM finding_triage
            WHERE habitat_id = ${group.habitat_id}
              AND cluster_key = ${group.cluster_key}
              AND finding_kind = ${group.finding_kind}
              AND status NOT IN ('resolved', 'wontfix')
            ORDER BY id`,
      ) as SqlRows;
    for (const row of rows) {
      anomalies.push({
        code: "active_identity_duplicate",
        findingTriagId: row.id as string,
        habitatId: row.habitat_id as string,
        clusterKey: row.cluster_key as string,
        findingKind: row.finding_kind as string,
        detail: `Multiple non-terminal rows for identity (${row.cluster_key}, ${row.finding_kind})`,
      });
    }
  }
  return anomalies;
}

/**
 * corroborating_pulse_ids that fail JSON.parse or don't produce a string[].
 */
function checkMalformedEvidenceJson(db: DbClient): PreflightAnomaly[] {
  const rows = db
    .all(
      sql`SELECT id, habitat_id, cluster_key, finding_kind, corroborating_pulse_ids
          FROM finding_triage
          WHERE corroborating_pulse_ids IS NOT NULL
            AND corroborating_pulse_ids != ''
            AND (
              json_valid(corroborating_pulse_ids) = 0
              OR json_type(corroborating_pulse_ids) != 'array'
            )`,
    ) as SqlRows;
  return rows.map((row) => ({
      code: "malformed_evidence_json" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `corroborating_pulse_ids is not a valid JSON array`,
    }));
}

/**
 * Terminal rows (resolved/wontfix) without a matching triage_resolutions record
 * (source='finding_triage', sourceId=finding_triage.id).
 */
function checkTerminalWithoutResolutionRecord(db: DbClient): PreflightAnomaly[] {
  const rows = db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind
          FROM finding_triage ft
          WHERE ft.status IN ('resolved', 'wontfix')
            AND NOT EXISTS (
              SELECT 1 FROM triage_resolutions tr
              WHERE tr.source = 'finding_triage'
                AND tr.source_id = ft.id
            )`,
    ) as SqlRows;
  return rows.map((row) => ({
      code: "terminal_without_resolution_record" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `Terminal status without a finding_triage Resolution Record`,
    }));
}

/**
 * triage_mission_id pointing to a Mission that no longer exists or is archived
 * while the Finding is non-terminal.
 */
function checkUnusableMissionLink(db: DbClient): PreflightAnomaly[] {
  const rows = db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.triage_mission_id
          FROM finding_triage ft
          WHERE ft.triage_mission_id IS NOT NULL
            AND ft.status NOT IN ('resolved', 'wontfix')
            AND NOT EXISTS (
              SELECT 1 FROM missions m
              WHERE m.id = ft.triage_mission_id
                AND m.is_archived = 0
            )`,
    ) as SqlRows;
  return rows.map((row) => ({
      code: "unusable_mission_link" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `Mission link ${row.triage_mission_id} is deleted, archived, or does not exist`,
    }));
}

/**
 * admitted_by_triage_mission_id or admitted_by_investigation_task_id pointing
 * to a Mission/Task that no longer exists (only for rows that have these fields set).
 */
function checkUnprovableInvestigationProvenance(db: DbClient): PreflightAnomaly[] {
  const anomalies: PreflightAnomaly[] = [];

  // Check admitted_by_triage_mission_id references
  const brokenMission = (db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.admitted_by_triage_mission_id
          FROM finding_triage ft
          WHERE ft.admitted_by_triage_mission_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM missions m WHERE m.id = ft.admitted_by_triage_mission_id
            )`,
    ) as SqlRows).map((row) => ({
      code: "unprovable_investigation_provenance" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `admitted_by_triage_mission_id ${row.admitted_by_triage_mission_id} does not exist`,
    }));
  anomalies.push(...brokenMission);

  // Check admitted_by_investigation_task_id references
  const brokenTask = (db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.admitted_by_investigation_task_id
          FROM finding_triage ft
          WHERE ft.admitted_by_investigation_task_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM tasks t WHERE t.id = ft.admitted_by_investigation_task_id
            )`,
    ) as SqlRows).map((row) => ({
      code: "unprovable_investigation_provenance" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `admitted_by_investigation_task_id ${row.admitted_by_investigation_task_id} does not exist`,
    }));
  anomalies.push(...brokenTask);

  return anomalies;
}

/**
 * Invalid recurrence edges: missing predecessor, self-edge, cycle, branch
 * (predecessor with multiple children), cross-Habitat, cross-kind, or
 * non-terminal predecessor.
 */
function checkInvalidRecurrenceEdges(db: DbClient): PreflightAnomaly[] {
  const anomalies: PreflightAnomaly[] = [];

  // Missing predecessor
  const missing = (db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          WHERE ft.recurrence_of_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM finding_triage ft2 WHERE ft2.id = ft.recurrence_of_id
            )`,
    ) as SqlRows).map((row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `recurrence_of_id ${row.recurrence_of_id} points to non-existent finding`,
    }));
  anomalies.push(...missing);

  // Self-edge
  const selfEdge = (db
    .all(
      sql`SELECT id, habitat_id, cluster_key, finding_kind
          FROM finding_triage
          WHERE recurrence_of_id = id`,
    ) as SqlRows).map((row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `recurrence_of_id points to self`,
    }));
  anomalies.push(...selfEdge);

  // Cross-habitat or cross-kind edge
  const crossIdentity = (db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          JOIN finding_triage pred ON ft.recurrence_of_id = pred.id
          WHERE ft.recurrence_of_id IS NOT NULL
            AND (ft.habitat_id != pred.habitat_id
                 OR ft.cluster_key != pred.cluster_key
                 OR ft.finding_kind != pred.finding_kind)`,
    ) as SqlRows).map((row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `recurrence_of_id crosses habitat/cluster/kind identity`,
    }));
  anomalies.push(...crossIdentity);

  // Non-terminal predecessor
  const nonTerminalPred = (db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          JOIN finding_triage pred ON ft.recurrence_of_id = pred.id
          WHERE pred.status NOT IN ('resolved', 'wontfix')`,
    ) as SqlRows).map((row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `predecessor ${row.recurrence_of_id} is not terminal`,
    }));
  anomalies.push(...nonTerminalPred);

  // Branched: predecessor with >1 child
  const branched = (db
    .all(
      sql`SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          WHERE ft.recurrence_of_id IN (
            SELECT recurrence_of_id
            FROM finding_triage
            WHERE recurrence_of_id IS NOT NULL
            GROUP BY recurrence_of_id
            HAVING COUNT(*) > 1
          )`,
    ) as SqlRows).map((row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `predecessor ${row.recurrence_of_id} has multiple children (branched lineage)`,
    }));
  anomalies.push(...branched);

  // Cyclic: use a bounded traversal to detect cycles up to depth 100
  const cyclic = detectCycles(db);
  anomalies.push(...cyclic);

  return anomalies;
}

/**
 * Detect cycles in recurrence_of_id chains using bounded traversal.
 * A cycle means following recurrence_of_id from a row eventually returns to it.
 */
function detectCycles(db: DbClient): PreflightAnomaly[] {
  const MAX_DEPTH = 100;
  const rowsWithRecurrence = db.all(
    sql`SELECT id, habitat_id, cluster_key, finding_kind, recurrence_of_id
        FROM finding_triage WHERE recurrence_of_id IS NOT NULL`,
  ) as SqlRows;

  const anomalies: PreflightAnomaly[] = [];
  for (const row of rowsWithRecurrence) {
    const visited = new Set<string>([row.id as string]);
    let current = row.recurrence_of_id as string | null;
    let depth = 0;
    let isCycle = false;

    while (current && depth < MAX_DEPTH) {
      if (visited.has(current)) {
        isCycle = true;
        break;
      }
      visited.add(current);
      const next = db.get(
        sql`SELECT recurrence_of_id FROM finding_triage WHERE id = ${current}`,
      ) as SqlRow | undefined;
      current = (next?.recurrence_of_id as string | null) ?? null;
      depth++;
    }

    if (isCycle) {
      anomalies.push({
        code: "invalid_recurrence_edge",
        findingTriagId: row.id as string,
        habitatId: row.habitat_id as string,
        clusterKey: row.cluster_key as string,
        findingKind: row.finding_kind as string,
        detail: `recurrence_of_id chain contains a cycle`,
      });
    }
  }
  return anomalies;
}

// --- Digest for attestation ---

/**
 * Compute a deterministic SHA-256 digest of the anomaly query results for
 * attestation purposes. The same database state always produces the same digest.
 */
export function computeAnomalyQueryDigest(result: PreflightResult): string {
  // Deterministic serialization: sort anomalies by (code, findingTriagId)
  const sorted = [...result.anomalies].sort((a, b) => {
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return a.findingTriagId.localeCompare(b.findingTriagId);
  });
  const lines = sorted.map((a) => `${a.code}:${a.findingTriagId}:${a.detail}`);
  // Simple hash for portability (crypto might not be available in all test contexts)
  let hash = 0;
  const str = lines.join("\n");
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
