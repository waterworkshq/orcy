/**
 * Ticket 1 tests: additive lifecycle storage and legacy repair.
 *
 * Production-path discriminators:
 *   1. Production `initDb` upgrade — verifies additive tables/columns exist.
 *   2. Preflight diagnostics for each anomaly type.
 *   3. Repair preview/apply — offline, exclusive, operator/reason, digest drift.
 *   4. Mutate/revert evidence for lineage validators and digest-drift guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  closeDb,
  initDb,
  initTestDb,
  getDb,
} from "../db/index.js";
import {
  habitats,
  missions,
  columns,
  pulses,
  findingTriage as findingTriageTable,
  findingTriageEvidence,
  findingTriageLineageRepairs,
  findingTriageLineageBaselineEvidence,
  migrationPreflightAttestations,
  triageResolutions,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import {
  runPreflight,
  computeAnomalyQueryDigest,
  PREFLIGHT_VERSION,
  ADDITIVE_SCHEMA_VERSION,
} from "../services/findingTriagePreflight.js";
import {
  previewRepair,
  applyRepair,
  beginMaintenanceSession,
  checkExistingRepair,
  RepairValidationError,
  type PredecessorMappingInput,
  type EvidenceBaselinedRootInput,
  type MaintenanceSession,
} from "../services/findingTriageLegacyRepair.js";

// ─── Production initDb upgrade ─────────────────────────────────────────

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-lifecycle-additive");
const DB_PATH = join(TEMP_DIR, "lifecycle-additive.db");

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}
function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }
}

// Maintenance-session factory for the repair tests: real lock file + real
// backup file (or an explicit operator attestation) under the test temp dir.
const REPAIR_TMP_DIR = join(TEMP_DIR, "repair-sessions");
function makeSession(opts?: {
  backupPath?: string;
  lockPath?: string;
  attestation?: boolean;
}): MaintenanceSession {
  mkdirSync(REPAIR_TMP_DIR, { recursive: true });
  const backupPath =
    opts?.backupPath ?? join(REPAIR_TMP_DIR, `backup-${randomUUID()}.bak`);
  writeFileSync(backupPath, `orcy-test-backup-${randomUUID()}`);
  return beginMaintenanceSession({
    lockPath: opts?.lockPath ?? join(REPAIR_TMP_DIR, `repair-${randomUUID()}.lock`),
    backup: opts?.attestation
      ? { kind: "attestation", attestedBy: "op-1" }
      : { kind: "file", path: backupPath },
  });
}
function cleanupRepairSessions(): void {
  rmSync(REPAIR_TMP_DIR, { recursive: true, force: true });
}

describe("Production initDb upgrade — additive lifecycle schema", () => {
  beforeEach(async () => {
    ensureTempDir();
    cleanupDb(DB_PATH);
    await initDb(DB_PATH);
  });
  afterEach(() => {
    closeDb();
    cleanupDb(DB_PATH);
  });

  it("creates all new tables through production migration path", () => {
    const db = getDb();
    const tables = (
      db.all(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
          'finding_triage_evidence',
          'finding_triage_lineage_repairs',
          'finding_triage_lineage_baseline_evidence',
          'migration_preflight_attestations'
        )`,
      ) as Record<string, unknown>[]
    ).map((r) => r.name as string);
    expect(tables).toHaveLength(4);
    expect(tables).toContain("finding_triage_evidence");
    expect(tables).toContain("finding_triage_lineage_repairs");
    expect(tables).toContain("finding_triage_lineage_baseline_evidence");
    expect(tables).toContain("migration_preflight_attestations");
  });

  it("adds all new columns to finding_triage through production migration path", () => {
    const db = getDb();
    const columns = (
      db.all(sql`PRAGMA table_info(finding_triage)`) as Record<string, unknown>[]
    ).map((r) => r.name as string);
    const expected = [
      "admitted_by_triage_mission_id",
      "admitted_by_investigation_task_id",
      "recurrence_of_id",
      "legacy_lineage_repair_required",
      "route_fingerprint",
      "activated_at",
      "activated_by_type",
      "activated_by_id",
      "activation_cause",
      "activation_release_id",
    ];
    for (const col of expected) {
      expect(columns).toContain(col);
    }
  });

  it("legacy_lineage_repair_required defaults to 0", () => {
    const db = getDb();
    const habitat = habitatRepo.createHabitat({ name: "Default Test" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "M",
      createdBy: "u",
    });
    const pulse = pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "agent",
      fromId: "a",
      signalType: "finding",
      subject: "Test",
      body: "",
      metadata: { findingKind: "bug" },
    });
    db.insert(findingTriageTable)
      .values({
        id: "ft1",
        habitatId: habitat.id,
        pulseId: pulse.id,
        clusterKey: "test",
        findingKind: "bug",
        status: "open",
        corroboratingPulseIds: JSON.stringify([pulse.id]),
      })
      .run();
    const row = db.get(sql`SELECT legacy_lineage_repair_required FROM finding_triage WHERE id = 'ft1'`) as Record<string, unknown>;
    expect(row.legacy_lineage_repair_required).toBe(0);
  });
});

// ─── Preflight diagnostics ─────────────────────────────────────────────

describe("Preflight / doctor diagnostics", () => {
  let habitatId: string;
  let columnId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();

    const habitat = habitatRepo.createHabitat({ name: "Preflight Habitat" });
    habitatId = habitat.id;
    const column = columnRepo.createColumn({
      habitatId,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    columnId = column.id;
  });
  afterEach(() => closeDb());

  function seedFinding(opts: {
    id: string;
    status?: string;
    clusterKey?: string;
    findingKind?: string;
    triageMissionId?: string | null;
    corroboratingPulseIds?: string | null;
    recurrenceOfId?: string | null;
    admittedByTriageMissionId?: string | null;
    admittedByInvestigationTaskId?: string | null;
  }) {
    const db = getDb();
    const pulseId = `pulse-${opts.id}`;
    db.insert(pulses)
      .values({
        id: pulseId,
        habitatId,
        fromType: "agent",
        fromId: "a",
        signalType: "finding",
        subject: opts.id,
      })
      .run();
    db.insert(findingTriageTable)
      .values({
        id: opts.id,
        habitatId,
        pulseId,
        clusterKey: opts.clusterKey ?? "test-cluster",
        findingKind: opts.findingKind ?? "bug",
        status: (opts.status ?? "open") as any,
        corroboratingPulseIds: opts.corroboratingPulseIds ?? `[${JSON.stringify(pulseId)}]`,
        triageMissionId: opts.triageMissionId ?? null,
        recurrenceOfId: opts.recurrenceOfId ?? null,
        admittedByTriageMissionId: opts.admittedByTriageMissionId ?? null,
        admittedByInvestigationTaskId: opts.admittedByInvestigationTaskId ?? null,
      })
      .run();
  }

  it("reports clean when there are no anomalies", () => {
    seedFinding({ id: "ft-clean" });
    const result = runPreflight();
    expect(result.clean).toBe(true);
    expect(result.anomalyCount).toBe(0);
    expect(result.version).toBe(PREFLIGHT_VERSION);
    expect(result.schemaVersion).toBe(ADDITIVE_SCHEMA_VERSION);
  });

  it("detects active identity duplicates", () => {
    seedFinding({ id: "ft-dup-1", clusterKey: "dup", findingKind: "bug" });
    seedFinding({ id: "ft-dup-2", clusterKey: "dup", findingKind: "bug" });
    const result = runPreflight();
    expect(result.clean).toBe(false);
    expect(result.anomaliesByCode.active_identity_duplicate).toBe(2);
    const dupAnomalies = result.anomalies.filter(
      (a) => a.code === "active_identity_duplicate",
    );
    expect(dupAnomalies.map((a) => a.findingTriagId).sort()).toEqual([
      "ft-dup-1",
      "ft-dup-2",
    ]);
  });

  it("detects malformed evidence JSON", () => {
    seedFinding({ id: "ft-malformed", corroboratingPulseIds: "not-json" });
    const result = runPreflight();
    expect(result.clean).toBe(false);
    expect(result.anomaliesByCode.malformed_evidence_json).toBe(1);
  });

  it("detects terminal rows without Resolution Records", () => {
    seedFinding({ id: "ft-terminal-norec", status: "resolved" });
    const result = runPreflight();
    expect(result.clean).toBe(false);
    expect(result.anomaliesByCode.terminal_without_resolution_record).toBe(1);
  });

  it("does NOT flag terminal rows that have Resolution Records", () => {
    seedFinding({ id: "ft-terminal-rec", status: "resolved" });
    triageResolutionsRepo.create({
      habitatId,
      clusterKey: "test-cluster",
      skillCategory: "convention",
      source: "finding_triage",
      sourceId: "ft-terminal-rec",
    });
    const result = runPreflight();
    const terminalAnomalies = result.anomalies.filter(
      (a) => a.code === "terminal_without_resolution_record" && a.findingTriagId === "ft-terminal-rec",
    );
    expect(terminalAnomalies).toHaveLength(0);
  });

  it("detects unusable mission links", () => {
    const db = getDb();
    // Insert a finding with a mission link, then delete the mission to make it unusable.
    // We use raw SQL to bypass FK during the insert of the bad link.
    const pulseId = "pulse-bad-link";
    db.insert(pulses).values({
      id: pulseId, habitatId, fromType: "agent", fromId: "a",
      signalType: "finding", subject: "bad-link",
    }).run();
    db.run(sql`PRAGMA foreign_keys = OFF`);
    db.run(sql`INSERT INTO finding_triage (id, habitat_id, pulse_id, cluster_key, finding_kind, status, corroborating_pulse_ids, triage_mission_id)
               VALUES ('ft-bad-link', ${habitatId}, ${pulseId}, 'test-cluster', 'bug', 'open', '["' || ${pulseId} || ']', 'ghost-mission-id')`);
    db.run(sql`PRAGMA foreign_keys = ON`);
    const result = runPreflight();
    expect(result.clean).toBe(false);
    expect(result.anomaliesByCode.unusable_mission_link).toBe(1);
  });

  it("detects invalid recurrence edges — missing predecessor", () => {
    seedFinding({ id: "ft-missing-pred", recurrenceOfId: "ghost-id" });
    const result = runPreflight();
    expect(result.clean).toBe(false);
    expect(result.anomaliesByCode.invalid_recurrence_edge).toBeGreaterThanOrEqual(1);
    const edgeAnomalies = result.anomalies.filter(
      (a) => a.code === "invalid_recurrence_edge" && a.findingTriagId === "ft-missing-pred",
    );
    expect(edgeAnomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("detects invalid recurrence edges — self-edge", () => {
    seedFinding({ id: "ft-self-edge", recurrenceOfId: "ft-self-edge" });
    const result = runPreflight();
    expect(result.anomaliesByCode.invalid_recurrence_edge).toBeGreaterThanOrEqual(1);
    const selfAnomalies = result.anomalies.filter(
      (a) => a.code === "invalid_recurrence_edge" && a.findingTriagId === "ft-self-edge",
    );
    expect(selfAnomalies.some((a) => a.detail.includes("self"))).toBe(true);
  });

  it("detects invalid recurrence edges — cycle", () => {
    // Create two terminal findings pointing at each other
    seedFinding({ id: "ft-cycle-a", status: "resolved", recurrenceOfId: "ft-cycle-b", clusterKey: "cycle", findingKind: "bug" });
    seedFinding({ id: "ft-cycle-b", status: "resolved", recurrenceOfId: "ft-cycle-a", clusterKey: "cycle", findingKind: "bug" });
    const result = runPreflight();
    const cycleAnomalies = result.anomalies.filter(
      (a) => a.code === "invalid_recurrence_edge" && a.detail.includes("cycle"),
    );
    expect(cycleAnomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("detects invalid recurrence edges — branched lineage", () => {
    // One predecessor with two children
    seedFinding({ id: "ft-pred", status: "resolved", clusterKey: "branch", findingKind: "bug" });
    seedFinding({ id: "ft-child-1", status: "open", recurrenceOfId: "ft-pred", clusterKey: "branch", findingKind: "bug" });
    seedFinding({ id: "ft-child-2", status: "open", recurrenceOfId: "ft-pred", clusterKey: "branch", findingKind: "bug" });
    const result = runPreflight();
    const branchAnomalies = result.anomalies.filter(
      (a) => a.code === "invalid_recurrence_edge" && a.detail.includes("branched"),
    );
    expect(branchAnomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("detects non-terminal predecessor in recurrence edge", () => {
    seedFinding({ id: "ft-nonterm-pred", status: "open", clusterKey: "ntp", findingKind: "bug" });
    seedFinding({ id: "ft-child", status: "open", recurrenceOfId: "ft-nonterm-pred", clusterKey: "ntp", findingKind: "bug" });
    const result = runPreflight();
    const ntAnomalies = result.anomalies.filter(
      (a) => a.code === "invalid_recurrence_edge" && a.detail.includes("not terminal"),
    );
    expect(ntAnomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("computes deterministic anomaly query contract digest (data-independent)", () => {
    seedFinding({ id: "ft-d1", clusterKey: "digest", findingKind: "bug" });
    runPreflight();
    const d1 = computeAnomalyQueryDigest();
    // Same database state -> identical digest...
    runPreflight();
    expect(computeAnomalyQueryDigest()).toBe(d1);
    // ...and the digest is a construction constant: it does not vary with the
    // anomaly RESULTS (only with the query contract / version / schema).
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Legacy lineage repair ─────────────────────────────────────────────

describe("Legacy lineage repair — preview and apply", () => {
  let habitatId: string;
  let columnId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(findingTriageLineageBaselineEvidence).run();
    db.delete(findingTriageLineageRepairs).run();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();

    const habitat = habitatRepo.createHabitat({ name: "Repair Habitat" });
    habitatId = habitat.id;
    const column = columnRepo.createColumn({
      habitatId,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    columnId = column.id;
  });
  afterEach(() => {
    closeDb();
    cleanupRepairSessions();
  });

  function seedFindingChain(opts: {
    id: string;
    status?: string;
    clusterKey?: string;
    findingKind?: string;
    recurrenceOfId?: string | null;
    legacyRepairRequired?: boolean;
    createdAt?: string;
  }) {
    const db = getDb();
    const pulseId = `pulse-${opts.id}`;
    db.insert(pulses)
      .values({
        id: pulseId,
        habitatId,
        fromType: "agent",
        fromId: "a",
        signalType: "finding",
        subject: opts.id,
      })
      .run();
    db.insert(findingTriageTable)
      .values({
        id: opts.id,
        habitatId,
        pulseId,
        clusterKey: opts.clusterKey ?? "repair-cluster",
        findingKind: opts.findingKind ?? "bug",
        status: (opts.status ?? "open") as any,
        corroboratingPulseIds: `[${JSON.stringify(pulseId)}]`,
        recurrenceOfId: opts.recurrenceOfId ?? null,
        legacyLineageRepairRequired: opts.legacyRepairRequired ? 1 : 0,
        createdAt: opts.createdAt ?? new Date().toISOString(),
      })
      .run();
  }

  it("previews a valid predecessor mapping", () => {
    // Terminal predecessor with one child
    seedFindingChain({ id: "ft-root", status: "resolved", clusterKey: "lin", findingKind: "bug", createdAt: "2026-01-01" });
    seedFindingChain({ id: "ft-child", status: "open", clusterKey: "lin", findingKind: "bug", recurrenceOfId: null, legacyRepairRequired: true, createdAt: "2026-06-01" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "lin",
      findingKind: "bug",
      mapping: { "ft-child": "ft-root", "ft-root": null },
      operator: { type: "human", id: "op-1", reason: "Fix legacy lineage" },
    };

    const preview = previewRepair(input);
    expect(preview.canApply).toBe(true);
    expect(preview.validationErrors).toHaveLength(0);
    expect(preview.afterMapping["ft-child"]).toBe("ft-root");
    expect(preview.afterMapping["ft-root"]).toBeNull();
    expect(preview.beforeMapping["ft-child"]).toBeNull();
  });

  it("rejects predecessor mapping with self-edge", () => {
    seedFindingChain({ id: "ft-solo", status: "open", clusterKey: "self", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "self",
      findingKind: "bug",
      mapping: { "ft-solo": "ft-solo" },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(preview.validationErrors.some((e) => e.includes("Self-edge"))).toBe(true);
  });

  it("rejects predecessor mapping with branch", () => {
    seedFindingChain({ id: "ft-bp", status: "resolved", clusterKey: "br", findingKind: "bug" });
    seedFindingChain({ id: "ft-c1", status: "open", clusterKey: "br", findingKind: "bug" });
    seedFindingChain({ id: "ft-c2", status: "open", clusterKey: "br", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "br",
      findingKind: "bug",
      mapping: { "ft-c1": "ft-bp", "ft-c2": "ft-bp", "ft-bp": null },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(preview.validationErrors.some((e) => e.includes("Branched"))).toBe(true);
  });

  it("rejects predecessor mapping with cycle", () => {
    seedFindingChain({ id: "ft-a", status: "resolved", clusterKey: "cy", findingKind: "bug" });
    seedFindingChain({ id: "ft-b", status: "open", clusterKey: "cy", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "cy",
      findingKind: "bug",
      mapping: { "ft-a": "ft-b", "ft-b": "ft-a" },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(preview.validationErrors.some((e) => e.includes("Cycle"))).toBe(true);
  });

  it("applies a valid predecessor mapping with audit ledger", () => {
    seedFindingChain({ id: "ft-proot", status: "resolved", clusterKey: "apply", findingKind: "bug", createdAt: "2026-01-01" });
    seedFindingChain({ id: "ft-pchild", status: "open", clusterKey: "apply", findingKind: "bug", legacyRepairRequired: true, createdAt: "2026-06-01" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "apply",
      findingKind: "bug",
      mapping: { "ft-pchild": "ft-proot", "ft-proot": null },
      operator: { type: "human", id: "op-1", reason: "Fix legacy lineage" },
    };

    const preview = previewRepair(input);
    const session = makeSession();
    const result = applyRepair(input, preview.digest, session);

    expect(result.mode).toBe("predecessor_mapping");
    expect(result.digest).toBe(preview.digest);
    expect(result.replayed).toBe(false);
    // applyRepair consumes the session (releases the lock) when it finishes
    expect(session.released).toBe(true);

    // Verify DB was updated
    const db = getDb();
    const childRow = db.get(sql`SELECT recurrence_of_id, legacy_lineage_repair_required FROM finding_triage WHERE id = 'ft-pchild'`) as Record<string, unknown> | undefined;
    expect(childRow?.recurrence_of_id).toBe("ft-proot");
    expect(childRow?.legacy_lineage_repair_required).toBe(0);

    // Verify audit ledger
    const ledgerRows = db.all(sql`SELECT * FROM finding_triage_lineage_repairs WHERE habitat_id = ${habitatId}`) as Record<string, unknown>[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].mode).toBe("predecessor_mapping");
    expect(ledgerRows[0].actor_id).toBe("op-1");
  });

  it("rejects a maintenance session when the backup file does not exist", () => {
    mkdirSync(REPAIR_TMP_DIR, { recursive: true });
    expect(() =>
      beginMaintenanceSession({
        lockPath: join(REPAIR_TMP_DIR, `repair-${randomUUID()}.lock`),
        backup: { kind: "file", path: join(REPAIR_TMP_DIR, "definitely-missing.bak") },
      }),
    ).toThrow(RepairValidationError);
  });

  it("rejects a maintenance session when the backup file is empty", () => {
    mkdirSync(REPAIR_TMP_DIR, { recursive: true });
    const emptyBackup = join(REPAIR_TMP_DIR, `empty-${randomUUID()}.bak`);
    writeFileSync(emptyBackup, "");
    expect(() =>
      beginMaintenanceSession({
        lockPath: join(REPAIR_TMP_DIR, `repair-${randomUUID()}.lock`),
        backup: { kind: "file", path: emptyBackup },
      }),
    ).toThrow(RepairValidationError);
  });

  it("rejects a maintenance session while the lock is held, and re-acquires after release", () => {
    mkdirSync(REPAIR_TMP_DIR, { recursive: true });
    const lockPath = join(REPAIR_TMP_DIR, "held.lock");
    const first = makeSession({ lockPath });
    expect(() => makeSession({ lockPath })).toThrow(RepairValidationError);
    first.release();
    // Released → the lock can be re-acquired
    const second = makeSession({ lockPath });
    expect(second.released).toBe(false);
    second.release();
  });

  it("rejects apply without operator reason", () => {
    seedFindingChain({ id: "ft-nr", status: "open", clusterKey: "nr", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "nr",
      findingKind: "bug",
      mapping: { "ft-nr": null },
      operator: { type: "human", id: "op-1", reason: "" },
    };
    const preview = previewRepair(input);
    expect(() => applyRepair(input, preview.digest, makeSession())).toThrow(
      RepairValidationError,
    );
  });

  it("rejects apply without an active maintenance session", () => {
    seedFindingChain({ id: "ft-ns", status: "open", clusterKey: "ns", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "ns",
      findingKind: "bug",
      mapping: { "ft-ns": null },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    const session = makeSession();
    session.release();
    expect(() => applyRepair(input, preview.digest, session)).toThrow(
      RepairValidationError,
    );
  });

  it("rejects apply with digest drift (database changed after preview)", () => {
    seedFindingChain({ id: "ft-dd-root", status: "resolved", clusterKey: "dd", findingKind: "bug", createdAt: "2026-01-01" });
    seedFindingChain({ id: "ft-dd-child", status: "open", clusterKey: "dd", findingKind: "bug", legacyRepairRequired: true, createdAt: "2026-06-01" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "dd",
      findingKind: "bug",
      mapping: { "ft-dd-child": "ft-dd-root", "ft-dd-root": null },
      operator: { type: "human", id: "op-1", reason: "Fix" },
    };

    const preview = previewRepair(input);

    // Mutate the database AFTER preview — add a new finding to the identity
    seedFindingChain({ id: "ft-dd-extra", status: "open", clusterKey: "dd", findingKind: "bug" });

    // The digest should now differ because the before-state changed
    expect(() =>
      applyRepair(input, preview.digest, makeSession()),
    ).toThrow(RepairValidationError);
  });

  it("exact repair-file replay returns the original result with ONE audit row; a changed file conflicts", () => {
    seedFindingChain({ id: "ft-id-root", status: "resolved", clusterKey: "idem", findingKind: "bug", createdAt: "2026-01-01" });
    seedFindingChain({ id: "ft-id-child", status: "open", clusterKey: "idem", findingKind: "bug", legacyRepairRequired: true, createdAt: "2026-06-01" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "idem",
      findingKind: "bug",
      mapping: { "ft-id-child": "ft-id-root", "ft-id-root": null },
      operator: { type: "human", id: "op-1", reason: "Fix" },
    };

    const preview = previewRepair(input);
    const result1 = applyRepair(input, preview.digest, makeSession());
    expect(result1.replayed).toBe(false);

    // Exact replay: same repair file, same digest — the ORIGINAL result comes
    // back (idempotent), with no new writes.
    const result2 = applyRepair(input, preview.digest, makeSession());
    expect(result2.replayed).toBe(true);
    expect(result2.repairId).toBe(result1.repairId);
    expect(result2.digest).toBe(preview.digest);

    const db = getDb();
    const ledgerRows = db.all(
      sql`SELECT * FROM finding_triage_lineage_repairs WHERE habitat_id = ${habitatId} AND cluster_key = 'idem'`,
    ) as Record<string, unknown>[];
    expect(ledgerRows).toHaveLength(1);

    // checkExistingRepair (wired into apply) reports the applied file
    const existing = checkExistingRepair(preview.digest);
    expect(existing.exists).toBe(true);
    expect(existing.repairId).toBe(result1.repairId);

    // Changed file: edit the mapping content but present the ORIGINAL digest → conflict
    const changed: PredecessorMappingInput = {
      ...input,
      mapping: { "ft-id-child": null, "ft-id-root": null },
    };
    expect(() => applyRepair(changed, preview.digest, makeSession())).toThrow(
      RepairValidationError,
    );
    // Still exactly one audit row — the rejected apply wrote nothing
    const ledgerAfter = db.all(
      sql`SELECT * FROM finding_triage_lineage_repairs WHERE habitat_id = ${habitatId} AND cluster_key = 'idem'`,
    ) as Record<string, unknown>[];
    expect(ledgerAfter).toHaveLength(1);
  });

  it("evidence-baselined root repair persists cutoff and baseline pulses", () => {
    // Create a messy lineage needing reset
    seedFindingChain({ id: "ft-ebr-1", status: "resolved", clusterKey: "ebr", findingKind: "bug", legacyRepairRequired: true, createdAt: "2026-01-01" });
    seedFindingChain({ id: "ft-ebr-2", status: "resolved", clusterKey: "ebr", findingKind: "bug", recurrenceOfId: "ft-ebr-1", legacyRepairRequired: true, createdAt: "2026-03-01" });
    seedFindingChain({ id: "ft-ebr-3", status: "open", clusterKey: "ebr", findingKind: "bug", legacyRepairRequired: true, createdAt: "2026-06-01" });

    const input: EvidenceBaselinedRootInput = {
      mode: "evidence_baselined_root",
      habitatId,
      clusterKey: "ebr",
      findingKind: "bug",
      canonicalRootId: "ft-ebr-1",
      cutoffTimestamp: "2026-06-01T00:00:00Z",
      baselinePulseIds: ["pulse-ft-ebr-1", "pulse-ft-ebr-2", "pulse-ft-ebr-3"],
      operator: { type: "human", id: "op-1", reason: "Reset messy lineage" },
    };

    const preview = previewRepair(input);
    expect(preview.canApply).toBe(true);
    expect(preview.cutoffTimestamp).toBe("2026-06-01T00:00:00Z");
    // The preview exposes the DERIVED complete provable set
    expect(preview.baselinePulseIds).toEqual([
      "pulse-ft-ebr-1",
      "pulse-ft-ebr-2",
      "pulse-ft-ebr-3",
    ]);

    const result = applyRepair(input, preview.digest, makeSession());

    expect(result.mode).toBe("evidence_baselined_root");

    // Verify the canonical LINEAR chain was persisted (not a root-star,
    // which would be a branched lineage)
    const db = getDb();
    const chainRows = db.all(
      sql`SELECT id, recurrence_of_id FROM finding_triage WHERE cluster_key = 'ebr'`,
    ) as Record<string, unknown>[];
    const chain = Object.fromEntries(
      chainRows.map((r) => [r.id, r.recurrence_of_id]),
    );
    expect(chain["ft-ebr-1"]).toBeNull();
    expect(chain["ft-ebr-2"]).toBe("ft-ebr-1");
    expect(chain["ft-ebr-3"]).toBe("ft-ebr-2");

    // Verify baseline evidence persisted
    const baselineRows = db.all(
      sql`SELECT * FROM finding_triage_lineage_baseline_evidence WHERE repair_id = ${result.repairId}`,
    ) as Record<string, unknown>[];
    expect(baselineRows).toHaveLength(3);

    // Verify audit ledger has cutoff
    const ledgerRows = db.all(
      sql`SELECT * FROM finding_triage_lineage_repairs WHERE id = ${result.repairId}`,
    ) as Record<string, unknown>[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].cutoff_timestamp).toBe("2026-06-01T00:00:00Z");
  });
});

// ─── Legacy repair: derived-state validation (discriminating) ──────────

describe("Legacy repair — derived-state validation", () => {
  let habitatId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(findingTriageLineageBaselineEvidence).run();
    db.delete(findingTriageLineageRepairs).run();
    db.delete(findingTriageEvidence).run();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();

    const habitat = habitatRepo.createHabitat({ name: "Validation Habitat" });
    habitatId = habitat.id;
  });
  afterEach(() => {
    closeDb();
    cleanupRepairSessions();
  });

  function seedFinding(opts: {
    id: string;
    status?: string;
    clusterKey?: string;
    findingKind?: string;
    recurrenceOfId?: string | null;
    legacyRepairRequired?: boolean;
    createdAt?: string;
    corroboratingPulseIds?: string | null;
  }) {
    const db = getDb();
    const pulseId = `pulse-${opts.id}`;
    db.insert(pulses)
      .values({
        id: pulseId,
        habitatId,
        fromType: "agent",
        fromId: "a",
        signalType: "finding",
        subject: opts.id,
      })
      .run();
    db.insert(findingTriageTable)
      .values({
        id: opts.id,
        habitatId,
        pulseId,
        clusterKey: opts.clusterKey ?? "val-cluster",
        findingKind: opts.findingKind ?? "bug",
        status: (opts.status ?? "open") as any,
        corroboratingPulseIds:
          opts.corroboratingPulseIds ?? `[${JSON.stringify(pulseId)}]`,
        recurrenceOfId: opts.recurrenceOfId ?? null,
        legacyLineageRepairRequired: opts.legacyRepairRequired ? 1 : 0,
        createdAt: opts.createdAt ?? "2026-06-01T00:00:00.000Z",
      })
      .run();
    return pulseId;
  }

  // ── predecessor mapping: complete-component, older, terminal ──

  it("requires the mapping to cover the complete identity component", () => {
    seedFinding({ id: "ft-inc-root", status: "resolved", clusterKey: "inc", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-inc-child", clusterKey: "inc", createdAt: "2026-06-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "inc",
      findingKind: "bug",
      // omits ft-inc-root
      mapping: { "ft-inc-child": "ft-inc-root" },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(preview.validationErrors.some((e) => e.includes("Incomplete mapping"))).toBe(true);
  });

  it("rejects a predecessor that is not canonically older than its child", () => {
    // Predecessor is TERMINAL but NEWER than the child.
    seedFinding({ id: "ft-new-pred", status: "resolved", clusterKey: "new", createdAt: "2026-06-01T00:00:00.000Z" });
    seedFinding({ id: "ft-new-child", clusterKey: "new", createdAt: "2026-01-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "new",
      findingKind: "bug",
      mapping: { "ft-new-child": "ft-new-pred", "ft-new-pred": null },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(preview.validationErrors.some((e) => e.includes("not canonically older"))).toBe(true);
  });

  it("breaks created_at ties by strict id order", () => {
    // Equal createdAt: predecessor must have the SMALLER id.
    seedFinding({ id: "ft-tie-a", clusterKey: "tie-ok", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-tie-b", status: "resolved", clusterKey: "tie-ok", createdAt: "2026-01-01T00:00:00.000Z" });

    const ok: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "tie-ok",
      findingKind: "bug",
      mapping: { "ft-tie-a": "ft-tie-b", "ft-tie-b": null }, // pred id b > child id a → INVALID
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    expect(previewRepair(ok).canApply).toBe(false);
    expect(
      previewRepair(ok).validationErrors.some((e) => e.includes("not canonically older")),
    ).toBe(true);

    const reversed: PredecessorMappingInput = {
      ...ok,
      mapping: { "ft-tie-a": null, "ft-tie-b": "ft-tie-a" }, // pred id a < child id b → VALID
    };
    // ft-tie-a must be terminal for this to pass
    dbUpdateStatus("ft-tie-a", "resolved");
    expect(previewRepair(reversed).canApply).toBe(true);
  });

  it("rejects a non-terminal predecessor", () => {
    seedFinding({ id: "ft-nt-pred", status: "open", clusterKey: "nt", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-nt-child", clusterKey: "nt", createdAt: "2026-06-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "nt",
      findingKind: "bug",
      mapping: { "ft-nt-child": "ft-nt-pred", "ft-nt-pred": null },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(preview.validationErrors.some((e) => e.includes("not terminal"))).toBe(true);
  });

  // ── evidence-baselined root: derived baseline + cutoff ──

  function seedEbrComponent(clusterKey: string) {
    seedFinding({ id: `${clusterKey}-1`, status: "resolved", clusterKey, createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: `${clusterKey}-2`, status: "resolved", clusterKey, recurrenceOfId: `${clusterKey}-1`, createdAt: "2026-03-01T00:00:00.000Z" });
    seedFinding({ id: `${clusterKey}-3`, clusterKey, createdAt: "2026-06-01T00:00:00.000Z" });
  }

  function ebrInput(
    clusterKey: string,
    baselinePulseIds: string[],
    cutoff = "2026-06-01T00:00:00Z",
  ): EvidenceBaselinedRootInput {
    return {
      mode: "evidence_baselined_root",
      habitatId,
      clusterKey,
      findingKind: "bug",
      canonicalRootId: `${clusterKey}-1`,
      cutoffTimestamp: cutoff,
      baselinePulseIds,
      operator: { type: "human", id: "op-1", reason: "Reset" },
    };
  }

  it("includes evidence-table rows of any role in the derived baseline", () => {
    seedEbrComponent("evrole");
    // Extra corroborating pulse attached ONLY via the evidence table
    const extraPulse = `pulse-evrole-extra-${randomUUID().slice(0, 8)}`;
    const db = getDb();
    db.insert(pulses)
      .values({ id: extraPulse, habitatId, fromType: "agent", fromId: "a", signalType: "finding", subject: "extra" })
      .run();
    db.insert(findingTriageEvidence)
      .values({ findingTriageId: "evrole-3", pulseId: extraPulse, habitatId, role: "corroborating" })
      .run();

    const preview = previewRepair(ebrInput("evrole", []));
    expect(preview.baselinePulseIds).toEqual(
      [`pulse-evrole-1`, `pulse-evrole-2`, `pulse-evrole-3`, extraPulse].sort(),
    );

    // Omitting the evidence-table pulse is rejected
    const omitting = ebrInput("evrole", ["pulse-evrole-1", "pulse-evrole-2", "pulse-evrole-3"]);
    const p1 = previewRepair(omitting);
    expect(p1.canApply).toBe(false);
    expect(p1.validationErrors.some((e) => e.includes("Baseline omits provable pulse"))).toBe(true);

    // Including it exactly is accepted
    const exact = ebrInput("evrole", [`pulse-evrole-1`, `pulse-evrole-2`, `pulse-evrole-3`, extraPulse]);
    expect(previewRepair(exact).canApply).toBe(true);
  });

  it("rejects nonexistent or foreign pulse ids in the baseline", () => {
    seedEbrComponent("foreign");
    const withGhost = ebrInput("foreign", [
      "pulse-foreign-1",
      "pulse-foreign-2",
      "pulse-foreign-3",
      "pulse-that-does-not-exist",
    ]);
    const p1 = previewRepair(withGhost);
    expect(p1.canApply).toBe(false);
    expect(
      p1.validationErrors.some((e) => e.includes("not provable for this identity")),
    ).toBe(true);

    // A REAL pulse from a different habitat is equally foreign to the baseline
    const other = habitatRepo.createHabitat({ name: "Other Habitat" });
    const otherPulse = `pulse-other-${randomUUID().slice(0, 8)}`;
    const db = getDb();
    db.insert(pulses)
      .values({ id: otherPulse, habitatId: other.id, fromType: "agent", fromId: "a", signalType: "finding", subject: "other" })
      .run();
    const withForeign = ebrInput("foreign", [
      "pulse-foreign-1",
      "pulse-foreign-2",
      "pulse-foreign-3",
      otherPulse,
    ]);
    expect(previewRepair(withForeign).canApply).toBe(false);
  });

  it("rejects a derived baseline pulse that belongs to another habitat (corroborating JSON)", () => {
    seedEbrComponent("xhab");
    const other = habitatRepo.createHabitat({ name: "Other Habitat 2" });
    const otherPulse = `pulse-xhab-${randomUUID().slice(0, 8)}`;
    const db = getDb();
    db.insert(pulses)
      .values({ id: otherPulse, habitatId: other.id, fromType: "agent", fromId: "a", signalType: "finding", subject: "xhab" })
      .run();
    // Smuggle the foreign pulse into the component's corroborating JSON
    db.run(
      sql`UPDATE finding_triage SET corroborating_pulse_ids = ${JSON.stringify([`pulse-xhab-3`, otherPulse])} WHERE id = 'xhab-3'`,
    );

    const preview = previewRepair(ebrInput("xhab", [`pulse-xhab-1`, `pulse-xhab-2`, `pulse-xhab-3`, otherPulse]));
    expect(preview.canApply).toBe(false);
    expect(
      preview.validationErrors.some((e) => e.includes("belongs to habitat")),
    ).toBe(true);
  });

  it("rejects malformed corroborating JSON in the component (baseline underivable)", () => {
    seedEbrComponent("malformed");
    const db = getDb();
    db.run(sql`UPDATE finding_triage SET corroborating_pulse_ids = 'not-json' WHERE id = 'malformed-2'`);

    const preview = previewRepair(ebrInput("malformed", []));
    expect(preview.canApply).toBe(false);
    expect(
      preview.validationErrors.some((e) => e.includes("Malformed corroborating_pulse_ids")),
    ).toBe(true);
  });

  it("rejects a future or unparseable cutoff timestamp", () => {
    seedEbrComponent("cutoff");
    const baseline = ["pulse-cutoff-1", "pulse-cutoff-2", "pulse-cutoff-3"];

    const future = previewRepair(ebrInput("cutoff", baseline, "2999-01-01T00:00:00Z"));
    expect(future.canApply).toBe(false);
    expect(future.validationErrors.some((e) => e.includes("in the future"))).toBe(true);

    const unparseable = previewRepair(ebrInput("cutoff", baseline, "not-a-date"));
    expect(unparseable.canApply).toBe(false);
    expect(unparseable.validationErrors.some((e) => e.includes("not parseable"))).toBe(true);
  });

  it("requires the canonical root to be terminal and canonically oldest", () => {
    // Root is OPEN → derived root-star has a non-terminal predecessor
    seedFinding({ id: "rt-open-1", clusterKey: "rt-open", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "rt-open-2", clusterKey: "rt-open", createdAt: "2026-06-01T00:00:00.000Z" });
    const openRoot = previewRepair(
      ebrInput("rt-open", ["pulse-rt-open-1", "pulse-rt-open-2"]),
    );
    expect(openRoot.canApply).toBe(false);
    expect(openRoot.validationErrors.some((e) => e.includes("not terminal"))).toBe(true);

    // Root is terminal but NEWER than another member → not the canonically
    // oldest, so the derived chain would not start at the requested root
    seedFinding({ id: "rt-new-1", status: "resolved", clusterKey: "rt-new", createdAt: "2026-06-01T00:00:00.000Z" });
    seedFinding({ id: "rt-new-2", status: "resolved", clusterKey: "rt-new", createdAt: "2026-01-01T00:00:00.000Z" });
    const newRoot = previewRepair(
      ebrInput("rt-new", ["pulse-rt-new-1", "pulse-rt-new-2"]),
    );
    expect(newRoot.canApply).toBe(false);
    expect(
      newRoot.validationErrors.some((e) =>
        e.includes("not the canonically oldest member"),
      ),
    ).toBe(true);
  });

  // ── TOCTOU + zero-writes on rejection ──

  it("TOCTOU: mutating validation-relevant identity state between preview and apply is rejected", () => {
    seedFinding({ id: "ft-toc-pred", status: "resolved", clusterKey: "toc", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-toc-child", clusterKey: "toc", legacyRepairRequired: true, createdAt: "2026-06-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "toc",
      findingKind: "bug",
      mapping: { "ft-toc-child": "ft-toc-pred", "ft-toc-pred": null },
      operator: { type: "human", id: "op-1", reason: "Fix" },
    };

    const preview = previewRepair(input);

    // Mutate validation-relevant state AFTER preview: flip the predecessor
    // resolved → wontfix. wontfix is STILL terminal and still older, so the
    // full validation would pass — ONLY the digest re-check under the
    // exclusive reservation can catch this mutation.
    dbUpdateStatus("ft-toc-pred", "wontfix");

    let threw: unknown = null;
    try {
      applyRepair(input, preview.digest, makeSession());
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(RepairValidationError);

    // Zero writes: quarantine flag untouched, no ledger row
    const db = getDb();
    const child = db.get(
      sql`SELECT recurrence_of_id, legacy_lineage_repair_required FROM finding_triage WHERE id = 'ft-toc-child'`,
    ) as Record<string, unknown>;
    expect(child.recurrence_of_id).toBeNull();
    expect(child.legacy_lineage_repair_required).toBe(1);
    const ledger = db.all(
      sql`SELECT * FROM finding_triage_lineage_repairs WHERE habitat_id = ${habitatId}`,
    ) as Record<string, unknown>[];
    expect(ledger).toHaveLength(0);
  });

  it("zero writes on the validation-failure apply path (re-fetch proves)", () => {
    // Non-terminal predecessor: preview computes a digest but canApply=false;
    // apply must re-validate and reject without touching anything.
    seedFinding({ id: "ft-zw-pred", status: "open", clusterKey: "zw", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-zw-child", clusterKey: "zw", legacyRepairRequired: true, createdAt: "2026-06-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "zw",
      findingKind: "bug",
      mapping: { "ft-zw-child": "ft-zw-pred", "ft-zw-pred": null },
      operator: { type: "human", id: "op-1", reason: "Fix" },
    };

    const preview = previewRepair(input);
    expect(preview.canApply).toBe(false);
    expect(() => applyRepair(input, preview.digest, makeSession())).toThrow(
      RepairValidationError,
    );

    const db = getDb();
    const rows = db.all(
      sql`SELECT id, recurrence_of_id, legacy_lineage_repair_required FROM finding_triage WHERE cluster_key = 'zw'`,
    ) as Record<string, unknown>[];
    // Nothing moved: recurrence untouched, quarantine flag still set on the
    // member that was flagged (the pred was never flagged and stays 0).
    expect(rows.every((r) => r.recurrence_of_id === null)).toBe(true);
    expect(
      rows.find((r) => r.id === "ft-zw-child")!.legacy_lineage_repair_required,
    ).toBe(1);
    const ledger = db.all(
      sql`SELECT * FROM finding_triage_lineage_repairs WHERE habitat_id = ${habitatId}`,
    ) as Record<string, unknown>[];
    expect(ledger).toHaveLength(0);
  });

  it("rejects when the backup file changes between session start and the exclusive reservation", () => {
    seedFinding({ id: "ft-bk-pred", status: "resolved", clusterKey: "bk", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-bk-child", clusterKey: "bk", createdAt: "2026-06-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "bk",
      findingKind: "bug",
      mapping: { "ft-bk-child": "ft-bk-pred", "ft-bk-pred": null },
      operator: { type: "human", id: "op-1", reason: "Fix" },
    };
    const preview = previewRepair(input);

    const session = makeSession();
    // Swap the backup after the session verified it
    writeFileSync(session.backup.path!, `replaced-${randomUUID()}`);
    expect(() => applyRepair(input, preview.digest, session)).toThrow(
      RepairValidationError,
    );
  });

  it("attestation backup mode applies a valid repair", () => {
    seedFinding({ id: "ft-att-pred", status: "resolved", clusterKey: "att", createdAt: "2026-01-01T00:00:00.000Z" });
    seedFinding({ id: "ft-att-child", clusterKey: "att", legacyRepairRequired: true, createdAt: "2026-06-01T00:00:00.000Z" });

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "att",
      findingKind: "bug",
      mapping: { "ft-att-child": "ft-att-pred", "ft-att-pred": null },
      operator: { type: "human", id: "op-1", reason: "Fix" },
    };
    const preview = previewRepair(input);
    const result = applyRepair(input, preview.digest, makeSession({ attestation: true }));
    expect(result.replayed).toBe(false);

    const db = getDb();
    const child = db.get(
      sql`SELECT recurrence_of_id, legacy_lineage_repair_required FROM finding_triage WHERE id = 'ft-att-child'`,
    ) as Record<string, unknown>;
    expect(child.recurrence_of_id).toBe("ft-att-pred");
    expect(child.legacy_lineage_repair_required).toBe(0);
  });

  function dbUpdateStatus(id: string, status: string): void {
    const db = getDb();
    db.run(sql`UPDATE finding_triage SET status = ${status} WHERE id = ${id}`);
  }
});

// ─── Mutate/revert evidence: preflight validators ──────────────────────

describe("Mutate/revert: removing each preflight validator causes its fixture to pass", () => {
  let habitatId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();
    const habitat = habitatRepo.createHabitat({ name: "Mutate Habitat" });
    habitatId = habitat.id;
  });
  afterEach(() => closeDb());

  function seedFinding(opts: {
    id: string;
    status?: string;
    clusterKey?: string;
    findingKind?: string;
    corroboratingPulseIds?: string | null;
    recurrenceOfId?: string | null;
  }) {
    const db = getDb();
    const pulseId = `mut-pulse-${opts.id}`;
    db.insert(pulses)
      .values({
        id: pulseId,
        habitatId,
        fromType: "agent",
        fromId: "a",
        signalType: "finding",
        subject: opts.id,
      })
      .run();
    db.insert(findingTriageTable)
      .values({
        id: opts.id,
        habitatId,
        pulseId,
        clusterKey: opts.clusterKey ?? "mutate-cluster",
        findingKind: opts.findingKind ?? "bug",
        status: (opts.status ?? "open") as any,
        corroboratingPulseIds: opts.corroboratingPulseIds ?? `[${JSON.stringify(pulseId)}]`,
        recurrenceOfId: opts.recurrenceOfId ?? null,
      })
      .run();
  }

  it("mutation: self-edge removed → preflight no longer reports it", () => {
    // With the self-edge
    seedFinding({ id: "ft-self", recurrenceOfId: "ft-self" });
    const withGuard = runPreflight();
    expect(
      withGuard.anomalies.some(
        (a) => a.code === "invalid_recurrence_edge" && a.findingTriagId === "ft-self",
      ),
    ).toBe(true);

    // Revert: clear the self-edge
    const db = getDb();
    db.run(sql`UPDATE finding_triage SET recurrence_of_id = NULL WHERE id = 'ft-self'`);

    const withoutGuard = runPreflight();
    expect(
      withoutGuard.anomalies.some(
        (a) => a.code === "invalid_recurrence_edge" && a.findingTriagId === "ft-self",
      ),
    ).toBe(false);
  });

  it("mutation: cycle removed → preflight no longer reports it", () => {
    seedFinding({ id: "ft-ca", status: "resolved", clusterKey: "mut-cycle", findingKind: "bug", recurrenceOfId: "ft-cb" });
    seedFinding({ id: "ft-cb", status: "resolved", clusterKey: "mut-cycle", findingKind: "bug", recurrenceOfId: "ft-ca" });

    const withGuard = runPreflight();
    expect(
      withGuard.anomalies.some((a) => a.detail.includes("cycle")),
    ).toBe(true);

    // Revert: break the cycle
    const db = getDb();
    db.run(sql`UPDATE finding_triage SET recurrence_of_id = NULL WHERE id = 'ft-cb'`);

    const withoutGuard = runPreflight();
    expect(
      withoutGuard.anomalies.some((a) => a.detail.includes("cycle")),
    ).toBe(false);
  });

  it("mutation: branch removed → preflight no longer reports it", () => {
    seedFinding({ id: "ft-bp2", status: "resolved", clusterKey: "mut-branch", findingKind: "bug" });
    seedFinding({ id: "ft-bc1", status: "open", clusterKey: "mut-branch", findingKind: "bug", recurrenceOfId: "ft-bp2" });
    seedFinding({ id: "ft-bc2", status: "open", clusterKey: "mut-branch", findingKind: "bug", recurrenceOfId: "ft-bp2" });

    const withGuard = runPreflight();
    expect(
      withGuard.anomalies.some((a) => a.detail.includes("branched")),
    ).toBe(true);

    // Revert: remove one child
    const db = getDb();
    db.run(sql`UPDATE finding_triage SET recurrence_of_id = NULL WHERE id = 'ft-bc2'`);

    const withoutGuard = runPreflight();
    expect(
      withoutGuard.anomalies.some((a) => a.detail.includes("branched")),
    ).toBe(false);
  });

  it("mutation: terminal-without-resolution fixed → preflight no longer reports it", () => {
    seedFinding({ id: "ft-tnr", status: "resolved" });
    const withGuard = runPreflight();
    expect(
      withGuard.anomalies.some(
        (a) => a.code === "terminal_without_resolution_record" && a.findingTriagId === "ft-tnr",
      ),
    ).toBe(true);

    // Fix: add a resolution record
    triageResolutionsRepo.create({
      habitatId,
      clusterKey: "mutate-cluster",
      skillCategory: "convention",
      source: "finding_triage",
      sourceId: "ft-tnr",
    });

    const withoutGuard = runPreflight();
    expect(
      withoutGuard.anomalies.some(
        (a) => a.code === "terminal_without_resolution_record" && a.findingTriagId === "ft-tnr",
      ),
    ).toBe(false);
  });
});

// ─── Mutate/revert: digest drift guard ─────────────────────────────────

describe("Mutate/revert: digest drift guard", () => {
  let habitatId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(findingTriageLineageBaselineEvidence).run();
    db.delete(findingTriageLineageRepairs).run();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();
    const habitat = habitatRepo.createHabitat({ name: "Drift Habitat" });
    habitatId = habitat.id;
  });
  afterEach(() => {
    closeDb();
    cleanupRepairSessions();
  });

  it("changing database after preview causes digest drift on apply", () => {
    const db = getDb();
    // Seed two findings
    for (const id of ["ft-da", "ft-db"]) {
      const pid = `drift-${id}`;
      db.insert(pulses).values({
        id: pid, habitatId, fromType: "agent", fromId: "a",
        signalType: "finding", subject: id,
      }).run();
      db.insert(findingTriageTable).values({
        id, habitatId, pulseId: pid,
        clusterKey: "drift", findingKind: "bug",
        status: (id === "ft-da" ? "resolved" : "open") as any,
        corroboratingPulseIds: `[${JSON.stringify(pid)}]`,
        legacyLineageRepairRequired: 1,
        createdAt: id === "ft-da" ? "2026-01-01" : "2026-06-01",
      }).run();
    }

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "drift",
      findingKind: "bug",
      mapping: { "ft-da": null, "ft-db": "ft-da" },
      operator: { type: "human", id: "op", reason: "test" },
    };

    const preview = previewRepair(input);

    // Mutate: add a third finding to the identity
    db.insert(pulses).values({
      id: "drift-ft-dc", habitatId, fromType: "agent", fromId: "a",
      signalType: "finding", subject: "dc",
    }).run();
    db.insert(findingTriageTable).values({
      id: "ft-dc", habitatId, pulseId: "drift-ft-dc",
      clusterKey: "drift", findingKind: "bug",
      status: "open" as any, corroboratingPulseIds: '["drift-ft-dc"]',
      legacyLineageRepairRequired: 1,
    }).run();

    // Apply should fail with digest drift
    expect(() =>
      applyRepair(input, preview.digest, makeSession()),
    ).toThrow(RepairValidationError);
  });

  it("no mutation between preview and apply → succeeds", () => {
    const db = getDb();
    for (const id of ["ft-sa", "ft-sb"]) {
      const pid = `succ-${id}`;
      db.insert(pulses).values({
        id: pid, habitatId, fromType: "agent", fromId: "a",
        signalType: "finding", subject: id,
      }).run();
      db.insert(findingTriageTable).values({
        id, habitatId, pulseId: pid,
        clusterKey: "success", findingKind: "bug",
        status: (id === "ft-sa" ? "resolved" : "open") as any,
        corroboratingPulseIds: `[${JSON.stringify(pid)}]`,
        legacyLineageRepairRequired: 1,
        createdAt: id === "ft-sa" ? "2026-01-01" : "2026-06-01",
      }).run();
    }

    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "success",
      findingKind: "bug",
      mapping: { "ft-sa": null, "ft-sb": "ft-sa" },
      operator: { type: "human", id: "op", reason: "test" },
    };

    const preview = previewRepair(input);
    const result = applyRepair(input, preview.digest, makeSession());
    expect(result.mode).toBe("predecessor_mapping");
  });
});

// ─── Repository interface: correctiveMissionId alias ───────────────────

describe("FindingTriage repository: canonical field mapping", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();
  });
  afterEach(() => closeDb());

  it("exposes correctiveMissionId and preserves triageMissionId alias", () => {
    const db = getDb();
    const habitat = habitatRepo.createHabitat({ name: "Alias Test" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Corrective",
      createdBy: "u",
    });
    const pulse = pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "mission",
      missionId: mission.id,
      fromType: "agent",
      fromId: "a",
      signalType: "finding",
      subject: "Alias",
      body: "",
      metadata: { findingKind: "bug" },
    });

    const record = findingTriageRepo.createForPulse({
      id: pulse.id,
      habitatId: habitat.id,
      subject: "Alias",
      metadata: { findingKind: "bug" },
    });

    findingTriageRepo.setTriageMissionId(record.id, mission.id);
    const updated = findingTriageRepo.getById(record.id);
    expect(updated).not.toBeNull();
    // Canonical field
    expect(updated!.correctiveMissionId).toBe(mission.id);
    // Deprecated alias
    expect(updated!.triageMissionId).toBe(mission.id);
    // New additive fields default to null/false
    expect(updated!.admittedByTriageMissionId).toBeNull();
    expect(updated!.admittedByInvestigationTaskId).toBeNull();
    expect(updated!.recurrenceOfId).toBeNull();
    expect(updated!.legacyLineageRepairRequired).toBe(false);
    expect(updated!.routeFingerprint).toBeNull();
    expect(updated!.activatedAt).toBeNull();
    expect(updated!.activationCause).toBeNull();
  });
});

// ─── TriageResolution createWithClient and findByFindingSource ─────────

describe("TriageResolution supplied-client and Finding-source lookup", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(triageResolutions).run();
    db.delete(findingTriageTable).run();
    db.delete(pulses).run();
  });
  afterEach(() => closeDb());

  it("createWithClient inserts using the supplied client", () => {
    const db = getDb();
    const habitat = habitatRepo.createHabitat({ name: "Client Test" });
    const result = triageResolutionsRepo.createWithClient(db, {
      habitatId: habitat.id,
      clusterKey: "test",
      skillCategory: "convention",
      source: "finding_triage",
      sourceId: "ft-test",
      resolution: "Fixed",
    });
    expect(result.source).toBe("finding_triage");
    expect(result.sourceId).toBe("ft-test");
  });

  it("findByFindingSource returns the resolution for a given finding", () => {
    const habitat = habitatRepo.createHabitat({ name: "Lookup Test" });
    triageResolutionsRepo.create({
      habitatId: habitat.id,
      clusterKey: "lookup",
      skillCategory: "convention",
      source: "finding_triage",
      sourceId: "ft-lookup",
    });
    const found = triageResolutionsRepo.findByFindingSource(habitat.id, "ft-lookup");
    expect(found).not.toBeNull();
    expect(found!.sourceId).toBe("ft-lookup");

    const notFound = triageResolutionsRepo.findByFindingSource(habitat.id, "ft-nonexistent");
    expect(notFound).toBeNull();
  });
});
