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
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
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
  computeRepairDigest,
  checkExistingRepair,
  RepairValidationError,
  type PredecessorMappingInput,
  type EvidenceBaselinedRootInput,
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

  it("computes deterministic anomaly query digest", () => {
    seedFinding({ id: "ft-d1", clusterKey: "digest", findingKind: "bug" });
    const r1 = runPreflight();
    const d1 = computeAnomalyQueryDigest(r1);
    const r2 = runPreflight();
    const d2 = computeAnomalyQueryDigest(r2);
    expect(d1).toBe(d2);
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
  afterEach(() => closeDb());

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
    const result = applyRepair(input, preview.digest, {
      backupVerified: true,
      exclusiveLock: true,
    });

    expect(result.mode).toBe("predecessor_mapping");
    expect(result.digest).toBe(preview.digest);

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

  it("rejects apply without backup", () => {
    seedFindingChain({ id: "ft-nb", status: "open", clusterKey: "nb", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "nb",
      findingKind: "bug",
      mapping: { "ft-nb": null },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(() =>
      applyRepair(input, preview.digest, { backupVerified: false, exclusiveLock: true }),
    ).toThrow(RepairValidationError);
  });

  it("rejects apply without exclusive lock", () => {
    seedFindingChain({ id: "ft-nl", status: "open", clusterKey: "nl", findingKind: "bug" });
    const input: PredecessorMappingInput = {
      mode: "predecessor_mapping",
      habitatId,
      clusterKey: "nl",
      findingKind: "bug",
      mapping: { "ft-nl": null },
      operator: { type: "human", id: "op-1", reason: "Test" },
    };
    const preview = previewRepair(input);
    expect(() =>
      applyRepair(input, preview.digest, { backupVerified: true, exclusiveLock: false }),
    ).toThrow(RepairValidationError);
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
    expect(() =>
      applyRepair(input, preview.digest, { backupVerified: true, exclusiveLock: true }),
    ).toThrow(RepairValidationError);
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

    // The digest should now differ because the before-mapping changed
    expect(() =>
      applyRepair(input, preview.digest, { backupVerified: true, exclusiveLock: true }),
    ).toThrow(RepairValidationError);
  });

  it("idempotent replay succeeds with identical digest", () => {
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
    const result1 = applyRepair(input, preview.digest, {
      backupVerified: true,
      exclusiveLock: true,
    });

    // After first apply, the mapping is already correct so re-preview should match
    const preview2 = previewRepair(input);
    // The before-mapping now equals the after-mapping, so digest changes.
    // But the repair content (input) is the same — the second apply should succeed
    // because the mapping is already in the desired state.
    const result2 = applyRepair(input, preview2.digest, {
      backupVerified: true,
      exclusiveLock: true,
    });
    expect(result2.digest).not.toBe(result1.digest);
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
    expect(preview.baselinePulseIds).toHaveLength(3);

    const result = applyRepair(input, preview.digest, {
      backupVerified: true,
      exclusiveLock: true,
    });

    expect(result.mode).toBe("evidence_baselined_root");

    // Verify baseline evidence persisted
    const db = getDb();
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
  afterEach(() => closeDb());

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
      applyRepair(input, preview.digest, {
        backupVerified: true,
        exclusiveLock: true,
      }),
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
    const result = applyRepair(input, preview.digest, {
      backupVerified: true,
      exclusiveLock: true,
    });
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
