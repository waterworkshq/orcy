/**
 * Finding Triage preflight / doctor.
 *
 * Standalone diagnostics for the additive lifecycle schema. Reports stable
 * machine-readable diagnostics for: active identity duplicates, Finding-source
 * Resolution duplicates, malformed evidence JSON, terminal rows without
 * Resolution Records, unusable Mission links, unprovable investigation
 * provenance, and invalid recurrence edges.
 *
 * This module is READ-ONLY with respect to production data. The staged
 * production migration runner runs it immediately before the enforcement
 * migration and gates enforcement on the BLOCKING codes only
 * (see BLOCKING_ANOMALY_CODES); advisory diagnostics are reported but do not
 * block, so pre-cutover data (e.g. terminal rows without Resolution Records)
 * cannot brick an upgrade.
 */

import { getDb } from "../db/index.js";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";

/**
 * Preflight version — bumped when the preflight construction changes.
 *
 * 002: digest is SHA-256 (was a 32-bit non-crypto hash), the additive schema
 * watermark extends through 0067, and the Finding-source Resolution duplicate
 * collision check was added.
 *
 * 003: the anomaly-query digest now pins the anomaly-query CONTRACT (the
 * exact static SQL of every check, plus version/schema/blocking policy) as a
 * data-independent constant, and the enforcement migration guard verifies
 * schema_version + anomaly_query_digest in addition to the version + clean
 * flag. Attestations written by older constructions fail the guard.
 */
export const PREFLIGHT_VERSION = "003";

/**
 * Schema version for the additive lifecycle chain. The additive watermark
 * extends through 0067 (0064 lifecycle storage, 0065 occurrences, 0066
 * automation revisions/inbox, 0067 release projections/epochs); enforcement
 * follows in a later entry and runs only after a clean 002 preflight
 * attestation against this schema.
 */
export const ADDITIVE_SCHEMA_VERSION = "0067";

/**
 * Anomaly codes whose presence BLOCKS the enforcement migration. Only the
 * uniqueness-collision classes block: they are exactly the conditions the
 * enforcement partial UNIQUE indexes cannot be created over. All other
 * diagnostics are advisory — pre-cutover installations legitimately carry
 * them (e.g. terminal rows without Resolution Records) and enforcement must
 * not brick on them.
 */
export const BLOCKING_ANOMALY_CODES: ReadonlySet<AnomalyCode> = new Set([
  "active_identity_duplicate",
  "finding_resolution_duplicate",
]);

/**
 * Stable categories of anomalies the doctor checks. Each has a stable
 * machine-readable code for operator tooling.
 */
export type AnomalyCode =
  | "active_identity_duplicate"
  | "finding_resolution_duplicate"
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

// --- Anomaly-query contract (pinned by the enforcement attestation guard) ---
//
// The static SQL below IS the executable primary query of each check — the
// checks run these exact strings via sql.raw(), so the registry cannot drift
// from what executes. computeAnomalyQueryDigest() hashes this registry (plus
// PREFLIGHT_VERSION, ADDITIVE_SCHEMA_VERSION and the blocking policy) into
// the constant the enforcement migration's guard pins: any change here
// changes the digest, and clean attestations written by an older
// construction abort enforcement instead of passing. Parametrized follow-up
// queries (per-group member enumeration, per-row cycle traversal) are
// deliberately outside the contract — they only elaborate anomalies already
// surfaced by these primary queries.

const CHECK_ACTIVE_IDENTITY_DUPLICATES_SQL = `SELECT id, habitat_id, cluster_key, finding_kind
          FROM finding_triage
          WHERE status NOT IN ('resolved', 'wontfix')
          GROUP BY habitat_id, cluster_key, finding_kind
          HAVING COUNT(*) > 1`;

const CHECK_FINDING_RESOLUTION_DUPLICATES_SQL = `SELECT tr.source_id, tr.habitat_id, tr.cluster_key,
                 (SELECT ft.finding_kind FROM finding_triage ft WHERE ft.id = tr.source_id) AS finding_kind
          FROM triage_resolutions tr
          WHERE tr.source = 'finding_triage'
          GROUP BY tr.source_id
          HAVING COUNT(*) > 1`;

const CHECK_MALFORMED_EVIDENCE_JSON_SQL = `SELECT id, habitat_id, cluster_key, finding_kind, corroborating_pulse_ids
          FROM finding_triage
          WHERE corroborating_pulse_ids IS NOT NULL
            AND corroborating_pulse_ids != ''
            AND (
              json_valid(corroborating_pulse_ids) = 0
              OR json_type(corroborating_pulse_ids) != 'array'
            )`;

const CHECK_TERMINAL_WITHOUT_RESOLUTION_RECORD_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind
          FROM finding_triage ft
          WHERE ft.status IN ('resolved', 'wontfix')
            AND NOT EXISTS (
              SELECT 1 FROM triage_resolutions tr
              WHERE tr.source = 'finding_triage'
                AND tr.source_id = ft.id
            )`;

const CHECK_UNUSABLE_MISSION_LINK_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.triage_mission_id
          FROM finding_triage ft
          WHERE ft.triage_mission_id IS NOT NULL
            AND ft.status NOT IN ('resolved', 'wontfix')
            AND NOT EXISTS (
              SELECT 1 FROM missions m
              WHERE m.id = ft.triage_mission_id
                AND m.is_archived = 0
            )`;

const CHECK_UNPROVABLE_PROVENANCE_MISSION_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.admitted_by_triage_mission_id
          FROM finding_triage ft
          WHERE ft.admitted_by_triage_mission_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM missions m WHERE m.id = ft.admitted_by_triage_mission_id
            )`;

const CHECK_UNPROVABLE_PROVENANCE_TASK_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.admitted_by_investigation_task_id
          FROM finding_triage ft
          WHERE ft.admitted_by_investigation_task_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM tasks t WHERE t.id = ft.admitted_by_investigation_task_id
            )`;

const CHECK_RECURRENCE_MISSING_PREDECESSOR_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          WHERE ft.recurrence_of_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM finding_triage ft2 WHERE ft2.id = ft.recurrence_of_id
            )`;

const CHECK_RECURRENCE_SELF_EDGE_SQL = `SELECT id, habitat_id, cluster_key, finding_kind
          FROM finding_triage
          WHERE recurrence_of_id = id`;

const CHECK_RECURRENCE_CROSS_IDENTITY_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          JOIN finding_triage pred ON ft.recurrence_of_id = pred.id
          WHERE ft.recurrence_of_id IS NOT NULL
            AND (ft.habitat_id != pred.habitat_id
                 OR ft.cluster_key != pred.cluster_key
                 OR ft.finding_kind != pred.finding_kind)`;

const CHECK_RECURRENCE_NON_TERMINAL_PRED_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          JOIN finding_triage pred ON ft.recurrence_of_id = pred.id
          WHERE pred.status NOT IN ('resolved', 'wontfix')`;

const CHECK_RECURRENCE_BRANCHED_SQL = `SELECT ft.id, ft.habitat_id, ft.cluster_key, ft.finding_kind, ft.recurrence_of_id
          FROM finding_triage ft
          WHERE ft.recurrence_of_id IN (
            SELECT recurrence_of_id
            FROM finding_triage
            WHERE recurrence_of_id IS NOT NULL
            GROUP BY recurrence_of_id
            HAVING COUNT(*) > 1
          )`;

const CHECK_RECURRENCE_CYCLE_ROWS_SQL = `SELECT id, habitat_id, cluster_key, finding_kind, recurrence_of_id
        FROM finding_triage WHERE recurrence_of_id IS NOT NULL`;

/**
 * Ordered registry of every anomaly check's primary queries. Order matches
 * runPreflight() execution order; the digest hashes entries in this order.
 */
const ANOMALY_CHECK_CONTRACT: readonly {
  code: AnomalyCode;
  queries: readonly string[];
}[] = [
  { code: "active_identity_duplicate", queries: [CHECK_ACTIVE_IDENTITY_DUPLICATES_SQL] },
  { code: "finding_resolution_duplicate", queries: [CHECK_FINDING_RESOLUTION_DUPLICATES_SQL] },
  { code: "malformed_evidence_json", queries: [CHECK_MALFORMED_EVIDENCE_JSON_SQL] },
  {
    code: "terminal_without_resolution_record",
    queries: [CHECK_TERMINAL_WITHOUT_RESOLUTION_RECORD_SQL],
  },
  { code: "unusable_mission_link", queries: [CHECK_UNUSABLE_MISSION_LINK_SQL] },
  {
    code: "unprovable_investigation_provenance",
    queries: [CHECK_UNPROVABLE_PROVENANCE_MISSION_SQL, CHECK_UNPROVABLE_PROVENANCE_TASK_SQL],
  },
  {
    code: "invalid_recurrence_edge",
    queries: [
      CHECK_RECURRENCE_MISSING_PREDECESSOR_SQL,
      CHECK_RECURRENCE_SELF_EDGE_SQL,
      CHECK_RECURRENCE_CROSS_IDENTITY_SQL,
      CHECK_RECURRENCE_NON_TERMINAL_PRED_SQL,
      CHECK_RECURRENCE_BRANCHED_SQL,
      CHECK_RECURRENCE_CYCLE_ROWS_SQL,
    ],
  },
];

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
    ...checkFindingResolutionDuplicates(db),
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
    "finding_resolution_duplicate",
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
  const groups = db.all(sql.raw(CHECK_ACTIVE_IDENTITY_DUPLICATES_SQL)) as SqlRows;

  const anomalies: PreflightAnomaly[] = [];
  for (const group of groups) {
    const rows = db.all(
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
 * Multiple Finding-sourced Resolution Records pointing at the same
 * finding_triage row. This is the exact collision the enforcement migration's
 * partial UNIQUE index on (source, source_id) WHERE source='finding_triage'
 * rejects — it must be resolved before enforcement.
 */
function checkFindingResolutionDuplicates(db: DbClient): PreflightAnomaly[] {
  const groups = db.all(sql.raw(CHECK_FINDING_RESOLUTION_DUPLICATES_SQL)) as SqlRows;
  return groups.map((row) => ({
    code: "finding_resolution_duplicate" as const,
    findingTriagId: row.source_id as string,
    habitatId: row.habitat_id as string,
    clusterKey: row.cluster_key as string,
    findingKind: (row.finding_kind as string | null) ?? "unknown",
    detail: `Multiple finding_triage Resolution Records for source ${row.source_id}`,
  }));
}

/**
 * corroborating_pulse_ids that fail JSON.parse or don't produce a string[].
 */
function checkMalformedEvidenceJson(db: DbClient): PreflightAnomaly[] {
  const rows = db.all(sql.raw(CHECK_MALFORMED_EVIDENCE_JSON_SQL)) as SqlRows;
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
  const rows = db.all(sql.raw(CHECK_TERMINAL_WITHOUT_RESOLUTION_RECORD_SQL)) as SqlRows;
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
  const rows = db.all(sql.raw(CHECK_UNUSABLE_MISSION_LINK_SQL)) as SqlRows;
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
  const brokenMission = (db.all(sql.raw(CHECK_UNPROVABLE_PROVENANCE_MISSION_SQL)) as SqlRows).map(
    (row) => ({
      code: "unprovable_investigation_provenance" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `admitted_by_triage_mission_id ${row.admitted_by_triage_mission_id} does not exist`,
    }),
  );
  anomalies.push(...brokenMission);

  // Check admitted_by_investigation_task_id references
  const brokenTask = (db.all(sql.raw(CHECK_UNPROVABLE_PROVENANCE_TASK_SQL)) as SqlRows).map(
    (row) => ({
      code: "unprovable_investigation_provenance" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `admitted_by_investigation_task_id ${row.admitted_by_investigation_task_id} does not exist`,
    }),
  );
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
  const missing = (db.all(sql.raw(CHECK_RECURRENCE_MISSING_PREDECESSOR_SQL)) as SqlRows).map(
    (row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `recurrence_of_id ${row.recurrence_of_id} points to non-existent finding`,
    }),
  );
  anomalies.push(...missing);

  // Self-edge
  const selfEdge = (db.all(sql.raw(CHECK_RECURRENCE_SELF_EDGE_SQL)) as SqlRows).map((row) => ({
    code: "invalid_recurrence_edge" as const,
    findingTriagId: row.id as string,
    habitatId: row.habitat_id as string,
    clusterKey: row.cluster_key as string,
    findingKind: row.finding_kind as string,
    detail: `recurrence_of_id points to self`,
  }));
  anomalies.push(...selfEdge);

  // Cross-habitat or cross-kind edge
  const crossIdentity = (db.all(sql.raw(CHECK_RECURRENCE_CROSS_IDENTITY_SQL)) as SqlRows).map(
    (row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `recurrence_of_id crosses habitat/cluster/kind identity`,
    }),
  );
  anomalies.push(...crossIdentity);

  // Non-terminal predecessor
  const nonTerminalPred = (db.all(sql.raw(CHECK_RECURRENCE_NON_TERMINAL_PRED_SQL)) as SqlRows).map(
    (row) => ({
      code: "invalid_recurrence_edge" as const,
      findingTriagId: row.id as string,
      habitatId: row.habitat_id as string,
      clusterKey: row.cluster_key as string,
      findingKind: row.finding_kind as string,
      detail: `predecessor ${row.recurrence_of_id} is not terminal`,
    }),
  );
  anomalies.push(...nonTerminalPred);

  // Branched: predecessor with >1 child
  const branched = (db.all(sql.raw(CHECK_RECURRENCE_BRANCHED_SQL)) as SqlRows).map((row) => ({
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
  const rowsWithRecurrence = db.all(sql.raw(CHECK_RECURRENCE_CYCLE_ROWS_SQL)) as SqlRows;

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
 * Compute the deterministic SHA-256 digest of the anomaly-query CONTRACT:
 * preflight version, additive schema version, every check's code and primary
 * SQL (in execution order), and the blocking policy. The value is a
 * data-independent constant for a given preflight construction — the
 * enforcement migration's attestation guard pins it, so a clean attestation
 * written by any other construction (different schema watermark or different
 * anomaly queries) aborts enforcement. Preflight version 001/002 hashed the
 * anomaly RESULTS instead (data-dependent, unpinnable); 003 pins the
 * construction.
 */
export function computeAnomalyQueryDigest(): string {
  const lines = [
    `preflight_version:${PREFLIGHT_VERSION}`,
    `schema_version:${ADDITIVE_SCHEMA_VERSION}`,
    ...ANOMALY_CHECK_CONTRACT.flatMap((c) => [
      `check:${c.code}`,
      ...c.queries.map((q) => `sql:${q}`),
    ]),
    ...[...BLOCKING_ANOMALY_CODES].sort().map((c) => `blocking:${c}`),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
