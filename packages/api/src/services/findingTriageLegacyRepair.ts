/**
 * Finding Triage legacy lineage repair.
 *
 * Offline maintenance operation for repairing ambiguous legacy lineage.
 * Two modes:
 *
 * 1. **predecessor_mapping** — validates and applies a known-good linear
 *    predecessor→child mapping. Reruns all linear-chain invariants.
 * 2. **evidence_baselined_root** — sets a canonical root (which must be the
 *    canonically oldest terminal member), re-links the complete component
 *    into a canonical linear chain, records a cutoff timestamp, and
 *    snapshots every provable Pulse id across the quarantined same-identity
 *    component. Post-reset recurrence requires a Pulse created strictly
 *    after the cutoff AND absent from the explicit baseline.
 *
 * Maintenance-command shape (nothing here is trusted from the caller that the
 * database can prove):
 *
 * - **Exclusive access is VERIFIED, not attested.** `beginMaintenanceSession`
 *   acquires an O_EXCL lock file (PID + timestamp; stale locks whose PID is no
 *   longer alive are reclaimed once) AND `applyRepair` runs the whole
 *   derive→validate→mutate→ledger sequence inside `BEGIN EXCLUSIVE`.
 *   EXCLUSIVE (not IMMEDIATE) is deliberate: IMMEDIATE still admits concurrent
 *   readers, while EXCLUSIVE blocks every other connection from reading or
 *   writing until COMMIT — the repair's derivation must observe a quiesced
 *   database. The lock file additionally fences a second repair process even
 *   before it reaches the database.
 * - **Backup is VERIFIED.** Accept a backup file path (must exist, be
 *   non-empty, and be unchanged — size + mtime — when re-checked under the
 *   exclusive reservation), or an explicit operator attestation
 *   (`{ kind: "attestation", attestedBy }`), which a CLI must gate behind an
 *   `--i-verified-backup` style flag. A bare boolean is never accepted.
 * - **BEGIN before re-read.** The reservation is acquired FIRST; the identity
 *   snapshot is derived inside it, so any mutation committed between preview
 *   and apply is visible in the re-derivation and rejected (digest drift).
 * - **Repair-file identity is stable.** The digest covers the repair FILE
 *   content (identity + canonical before-state + mapping/baseline), separate
 *   from the mutable database state. Exact replay of an applied file returns
 *   the original result with ONE audit row; a changed file conflicts.
 *
 * Programmatic surface for a future CLI script: `beginMaintenanceSession` →
 * `previewRepair` → `applyRepair` (one session per apply; `applyRepair`
 * releases the session when it finishes, success or failure). No HTTP/MCP
 * export — offline tooling only.
 */

import { getDb } from "../db/index.js";
import { findingTriageLineageRepairs, pulses as pulsesTable } from "../db/schema/index.js";
import { eq, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LineageRepairMode } from "@orcy/shared";
import { createHash } from "crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

/** Client type every function in this module accepts (defaults to getDb()). */
export type DbClient = ReturnType<typeof getDb>;

/** Required input for any repair. */
export interface RepairOperator {
  type: string;
  id: string;
  reason: string;
}

/** Input for a predecessor-mapping repair. */
export interface PredecessorMappingInput {
  mode: "predecessor_mapping";
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  /** Map of findingTriagId → predecessorId (null means "set as root").
   * Must cover EVERY member of the quarantined same-identity component. */
  mapping: Record<string, string | null>;
  operator: RepairOperator;
}

/** Input for an evidence-baselined-root repair. */
export interface EvidenceBaselinedRootInput {
  mode: "evidence_baselined_root";
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  /** The canonical root findingTriagId to set (must be terminal and
   * canonically the oldest member — every other member will point to it). */
  canonicalRootId: string;
  /** Cutoff timestamp: only evidence from Pulses created strictly after the
   * cutoff can establish recurrence. Must be a parseable ISO-8601 timestamp
   * that is not in the future at apply time. */
  cutoffTimestamp: string;
  /** Provable Pulse ids across the quarantined component. Must EXACTLY equal
   * the derived complete provable set (evidence rows of any role + each
   * member's source pulse_id + the union of corroboratingPulseIds JSON). */
  baselinePulseIds: string[];
  operator: RepairOperator;
}

export type RepairInput = PredecessorMappingInput | EvidenceBaselinedRootInput;

/** Preview result — what the repair would do without applying. */
export interface RepairPreview {
  mode: LineageRepairMode;
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  /** Stable repair-FILE digest (identity + before-state + content). */
  digest: string;
  /** Digest of the derived before-state alone (diagnostic; embedded in `digest`). */
  beforeStateDigest: string;
  beforeMapping: Record<string, string | null>;
  afterMapping: Record<string, string | null>;
  /** The DERIVED complete provable Pulse set the repair file must match (evidence mode). */
  baselinePulseIds?: string[];
  cutoffTimestamp?: string;
  validationErrors: string[];
  canApply: boolean;
}

/** Apply result — confirmation of what was persisted. */
export interface RepairApplyResult {
  repairId: string;
  mode: LineageRepairMode;
  appliedAt: string;
  digest: string;
  /** True when an identical repair file was already applied and the original
   * result was returned without any new writes. */
  replayed: boolean;
}

/** Error thrown when prerequisites are not met. */
export class RepairValidationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "RepairValidationError";
  }
}

// ─── Maintenance session: verified exclusive access + verified backup ───

/** How the operator proves a backup exists. Never a bare boolean. */
export type BackupVerification =
  | { kind: "file"; path: string }
  | { kind: "attestation"; attestedBy: string };

interface ResolvedBackup {
  mode: "file" | "attestation";
  path?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  attestedBy?: string;
}

/** A verified maintenance session: lock file held + backup verified. */
export interface MaintenanceSession {
  readonly lockPath: string;
  readonly acquiredAt: string;
  readonly backup: ResolvedBackup;
  /** True once release() has run (applyRepair releases automatically). */
  released: boolean;
  /** Remove the lock file. Idempotent. */
  release(): void;
}

/** Terminal lifecycle statuses — a valid predecessor must be terminal. */
const TERMINAL_STATUSES = new Set(["resolved", "wontfix"]);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is owned by another user.
    return (err as { code?: string })?.code === "EPERM";
  }
}

function acquireRepairLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as { code?: string })?.code !== "EEXIST") throw err;
      let content: string;
      try {
        content = readFileSync(lockPath, "utf8");
      } catch {
        throw new RepairValidationError(
          `Maintenance lock exists at ${lockPath} but cannot be read; remove it manually if stale.`,
          "maintenance_lock_held",
        );
      }
      const pid = Number.parseInt(content.split("\n")[0] ?? "", 10);
      const stale = !Number.isInteger(pid) || !isProcessAlive(pid);
      if (!stale || attempt === 1) {
        throw new RepairValidationError(
          `Maintenance lock held at ${lockPath} (pid ${Number.isInteger(pid) ? pid : "unknown"}). Another repair/maintenance process appears to be running.`,
          "maintenance_lock_held",
        );
      }
      // Stale (dead PID) — reclaim once.
      unlinkSync(lockPath);
    }
  }
}

function resolveBackup(backup: BackupVerification): ResolvedBackup {
  if (backup.kind === "attestation") {
    if (!backup.attestedBy || !backup.attestedBy.trim()) {
      throw new RepairValidationError(
        "Operator attestation requires the operator id (CLI: --i-verified-backup <operator-id>).",
        "backup_not_verifiable",
      );
    }
    return { mode: "attestation", attestedBy: backup.attestedBy };
  }
  let st;
  try {
    st = statSync(backup.path);
  } catch {
    throw new RepairValidationError(
      `Backup file ${backup.path} does not exist. Take a verified backup before repair.`,
      "backup_not_verifiable",
    );
  }
  if (!st.isFile() || st.size <= 0) {
    throw new RepairValidationError(
      `Backup file ${backup.path} is not a non-empty regular file.`,
      "backup_not_verifiable",
    );
  }
  return { mode: "file", path: backup.path, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Begin a verified maintenance session: acquire the exclusive-repair lock
 * file and verify the backup. One session covers ONE applyRepair call
 * (applyRepair releases it when it finishes).
 */
export function beginMaintenanceSession(opts: {
  lockPath: string;
  backup: BackupVerification;
}): MaintenanceSession {
  if (!opts?.lockPath) {
    throw new RepairValidationError(
      "A lock file path is required for the maintenance session.",
      "missing_maintenance_session",
    );
  }
  acquireRepairLock(opts.lockPath);
  let backup: ResolvedBackup;
  try {
    backup = resolveBackup(opts.backup);
  } catch (err) {
    try {
      unlinkSync(opts.lockPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
  const session: MaintenanceSession = {
    lockPath: opts.lockPath,
    acquiredAt: new Date().toISOString(),
    backup,
    released: false,
    release() {
      if (session.released) return;
      session.released = true;
      try {
        unlinkSync(session.lockPath);
      } catch {
        /* already gone */
      }
    },
  };
  return session;
}

/**
 * Re-verify a file-backed backup UNDER the exclusive reservation (DB
 * quiesced): the backup must still exist and be byte-identical (size + mtime)
 * to what the session verified. A backup swapped or deleted mid-session
 * aborts the repair before any mutation.
 */
function reverifyBackupUnderQuiesce(session: MaintenanceSession): void {
  if (session.backup.mode !== "file") return;
  let st;
  try {
    st = statSync(session.backup.path!);
  } catch {
    throw new RepairValidationError(
      `Backup file ${session.backup.path} disappeared before mutation.`,
      "backup_changed_under_quiesce",
    );
  }
  if (
    !st.isFile() ||
    st.size !== session.backup.sizeBytes ||
    st.mtimeMs !== session.backup.mtimeMs
  ) {
    throw new RepairValidationError(
      `Backup file ${session.backup.path} changed (size/mtime) between session start and the exclusive reservation.`,
      "backup_changed_under_quiesce",
    );
  }
}

// ─── Derived identity snapshot ─────────────────────────────────────────

/** One member of the quarantined same-identity component, as derived from the DB. */
export interface DerivedIdentityRow {
  id: string;
  status: string;
  createdAt: string;
  recurrenceOfId: string | null;
  legacyLineageRepairRequired: number;
  pulseId: string;
  /** Parsed corroboratingPulseIds; null when malformed (blocks baseline derivation). */
  corroboratingPulseIds: string[] | null;
}

/** The complete derived snapshot the repair file must exactly match. */
export interface DerivedRepairSnapshot {
  rows: DerivedIdentityRow[];
  evidenceRows: { findingTriageId: string; pulseId: string; role: string }[];
  /** Sorted union: evidence rows (any role) + member source pulse_ids + corroboratingPulseIds. */
  derivedBaselinePulseIds: string[];
  beforeMapping: Record<string, string | null>;
}

function parseCorroborating(raw: string | null): string[] | null {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * One deterministic same-identity query derives the full evidence/component
 * snapshot: every finding_triage row of the identity (ordered by the
 * canonical created_at-then-id order) plus every finding_triage_evidence row
 * (any role) attached to those rows.
 */
export function deriveIdentitySnapshot(
  client: DbClient,
  identity: { habitatId: string; clusterKey: string; findingKind: string },
): DerivedRepairSnapshot {
  const rows = (
    client.all(
      sql`SELECT id, status, created_at, recurrence_of_id, legacy_lineage_repair_required,
                 pulse_id, corroborating_pulse_ids
          FROM finding_triage
          WHERE habitat_id = ${identity.habitatId}
            AND cluster_key = ${identity.clusterKey}
            AND finding_kind = ${identity.findingKind}
          ORDER BY created_at, id`,
    ) as Record<string, unknown>[]
  ).map((row) => ({
    id: row.id as string,
    status: row.status as string,
    createdAt: row.created_at as string,
    recurrenceOfId: row.recurrence_of_id as string | null,
    legacyLineageRepairRequired: row.legacy_lineage_repair_required as number,
    pulseId: row.pulse_id as string,
    corroboratingPulseIds: parseCorroborating(row.corroborating_pulse_ids as string | null),
  }));

  const evidenceRows = (
    client.all(
      sql`SELECT e.finding_triage_id, e.pulse_id, e.role
          FROM finding_triage_evidence e
          JOIN finding_triage ft ON e.finding_triage_id = ft.id
          WHERE ft.habitat_id = ${identity.habitatId}
            AND ft.cluster_key = ${identity.clusterKey}
            AND ft.finding_kind = ${identity.findingKind}
          ORDER BY e.pulse_id`,
    ) as Record<string, unknown>[]
  ).map((row) => ({
    findingTriageId: row.finding_triage_id as string,
    pulseId: row.pulse_id as string,
    role: row.role as string,
  }));

  const baseline = new Set<string>();
  for (const row of rows) {
    baseline.add(row.pulseId);
    if (row.corroboratingPulseIds) {
      for (const pid of row.corroboratingPulseIds) baseline.add(pid);
    }
  }
  for (const e of evidenceRows) baseline.add(e.pulseId);

  const beforeMapping: Record<string, string | null> = {};
  for (const row of rows) beforeMapping[row.id] = row.recurrenceOfId;

  return {
    rows,
    evidenceRows,
    derivedBaselinePulseIds: [...baseline].sort(),
    beforeMapping,
  };
}

// ─── Digests ───────────────────────────────────────────────────────────

/**
 * Digest of the derived before-state: covers EVERY validation-relevant
 * column (status, created_at, recurrence_of_id, pulse_id, corroborating
 * JSON) of every identity member plus every evidence row. Any mutation of
 * validation-relevant state between preview and apply changes this digest
 * and apply rejects. `legacy_lineage_repair_required` is deliberately
 * excluded: nothing validates on it (it is the repair's OUTPUT quarantine
 * flag, not an input), and excluding it lets an exact replay reconstruct
 * the recorded before-state from the ledger's beforeMapping.
 */
export function computeBeforeStateDigest(snapshot: DerivedRepairSnapshot): string {
  const lines = [
    ...snapshot.rows
      .map(
        (r) =>
          `row:${r.id}|${r.status}|${r.createdAt}|${r.recurrenceOfId ?? ""}|${r.pulseId}|${(r.corroboratingPulseIds ?? ["<malformed>"]).slice().sort().join(",")}`,
      )
      .sort(),
    ...snapshot.evidenceRows.map((e) => `ev:${e.findingTriageId}|${e.pulseId}|${e.role}`).sort(),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Stable repair-FILE digest: the identity, the canonical before-state the
 * file was prepared against, and the repair content (mapping / root+cutoff+
 * baseline). Separate from the mutable before-state digest so an applied
 * file can be replayed by its own identity. The operator is deliberately
 * excluded — the ledger records the operator per event, and a replay must
 * resolve to the original audit row regardless of who replays it.
 */
export function computeRepairFileDigest(input: RepairInput, beforeStateDigest: string): string {
  const hash = createHash("sha256");
  if (input.mode === "predecessor_mapping") {
    const pairs = Object.keys(input.mapping)
      .sort()
      .map((k) => `${k}:${input.mapping[k] ?? "null"}`);
    hash.update(
      `predecessor_mapping|${input.habitatId}|${input.clusterKey}|${input.findingKind}|${beforeStateDigest}|${pairs.join(",")}`,
    );
  } else {
    const sortedPulses = [...input.baselinePulseIds].sort();
    hash.update(
      `evidence_baselined_root|${input.habitatId}|${input.clusterKey}|${input.findingKind}|${input.canonicalRootId}|${input.cutoffTimestamp}|${sortedPulses.join(",")}|${beforeStateDigest}`,
    );
  }
  return hash.digest("hex");
}

// ─── Validation ────────────────────────────────────────────────────────

/** Strict canonical order: predecessor older by created_at, tie-broken by id. */
function isCanonicallyOlder(pred: DerivedIdentityRow, child: DerivedIdentityRow): boolean {
  if (pred.createdAt < child.createdAt) return true;
  if (pred.createdAt > child.createdAt) return false;
  return pred.id < child.id;
}

/**
 * Validate linear-chain invariants over a COMPLETE mapping: no self-edge, no
 * cycle, no branch, predecessor same-identity (guaranteed by membership),
 * terminal, and canonically older than its child.
 */
function validateLinearChain(
  mapping: Record<string, string | null>,
  byId: Map<string, DerivedIdentityRow>,
  errors: string[],
): void {
  // Self-edges
  for (const [child, pred] of Object.entries(mapping)) {
    if (pred !== null && child === pred) {
      errors.push(`Self-edge: ${child} points to itself`);
    }
  }

  // Predecessor must be terminal AND canonically older (created_at, then id)
  for (const [childId, predId] of Object.entries(mapping)) {
    if (predId === null || predId === childId) continue;
    const child = byId.get(childId);
    const pred = byId.get(predId);
    if (!child || !pred) continue; // unknown ids reported separately
    if (!TERMINAL_STATUSES.has(pred.status)) {
      errors.push(`Predecessor ${predId} is not terminal (status ${pred.status})`);
    }
    if (!isCanonicallyOlder(pred, child)) {
      errors.push(
        `Predecessor ${predId} is not canonically older than ${childId} (created_at ${pred.createdAt} vs ${child.createdAt})`,
      );
    }
  }

  // Branches (predecessor with multiple children)
  const childCount: Record<string, number> = {};
  for (const pred of Object.values(mapping)) {
    if (pred !== null) {
      childCount[pred] = (childCount[pred] ?? 0) + 1;
    }
  }
  for (const [pred, count] of Object.entries(childCount)) {
    if (count > 1) {
      errors.push(`Branched lineage: predecessor ${pred} has ${count} children`);
    }
  }

  // Cycles (bounded traversal)
  const MAX_DEPTH = 100;
  for (const start of Object.keys(mapping)) {
    const visited = new Set<string>([start]);
    let current = mapping[start];
    let depth = 0;
    while (current && depth < MAX_DEPTH) {
      if (visited.has(current)) {
        errors.push(`Cycle detected starting from ${start}`);
        break;
      }
      visited.add(current);
      current = mapping[current] ?? null;
      depth++;
    }
  }
}

/** Canonical member order: created_at, then id (the strict older-than order). */
function orderMembersCanonically(rows: DerivedIdentityRow[]): DerivedIdentityRow[] {
  return [...rows].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
}

/**
 * Derive the after-mapping: explicit (pred mode) or the canonical LINEAR
 * CHAIN over the complete component (evidence mode), ordered by
 * (created_at, id) with the canonically oldest member — the canonical root —
 * as the chain head. A star (every member → root) would be a branched
 * lineage, which the module's own invariant forbids.
 */
function deriveAfterMapping(
  input: RepairInput,
  snapshot: DerivedRepairSnapshot,
): Record<string, string | null> {
  if (input.mode === "predecessor_mapping") {
    return { ...input.mapping };
  }
  const after: Record<string, string | null> = {};
  let prev: string | null = null;
  for (const row of orderMembersCanonically(snapshot.rows)) {
    after[row.id] = prev;
    prev = row.id;
  }
  return after;
}

/**
 * Full validation of a repair input against the DERIVED snapshot. Every
 * check must pass before any mutation runs (and the quarantine flag clears).
 */
export function validateRepair(
  input: RepairInput,
  snapshot: DerivedRepairSnapshot,
  client: DbClient,
): string[] {
  const errors: string[] = [];
  const byId = new Map(snapshot.rows.map((r) => [r.id, r]));

  if (input.mode === "predecessor_mapping") {
    // Complete component mapping required: every identity member is a key,
    // every key/predecessor is an identity member (same identity by construction).
    for (const row of snapshot.rows) {
      if (!(row.id in input.mapping)) {
        errors.push(`Incomplete mapping: identity member ${row.id} is not mapped`);
      }
    }
    for (const [child, pred] of Object.entries(input.mapping)) {
      if (!byId.has(child)) {
        errors.push(`Unknown finding id in mapping: ${child}`);
      }
      if (pred !== null && !byId.has(pred)) {
        errors.push(`Unknown predecessor id in mapping: ${pred}`);
      }
    }
    validateLinearChain(input.mapping, byId, errors);
    return errors;
  }

  // evidence_baselined_root
  if (!byId.has(input.canonicalRootId)) {
    errors.push(`Canonical root ${input.canonicalRootId} does not exist in this identity`);
  }

  // The complete provable set must be derivable: malformed corroborating JSON
  // anywhere in the component blocks the repair.
  for (const row of snapshot.rows) {
    if (row.corroboratingPulseIds === null) {
      errors.push(
        `Malformed corroborating_pulse_ids on ${row.id}; the complete provable baseline cannot be derived`,
      );
    }
  }

  // Every derived baseline pulse must exist and belong to this habitat.
  if (snapshot.derivedBaselinePulseIds.length > 0) {
    const pulseRows = lookupPulses(client, snapshot.derivedBaselinePulseIds);
    const pulseById = new Map(pulseRows.map((p) => [p.id, p]));
    for (const pid of snapshot.derivedBaselinePulseIds) {
      const pulse = pulseById.get(pid);
      if (!pulse) {
        errors.push(`Derived baseline pulse ${pid} does not exist in pulses`);
      } else if (pulse.habitatId !== input.habitatId) {
        errors.push(
          `Derived baseline pulse ${pid} belongs to habitat ${pulse.habitatId}, not ${input.habitatId}`,
        );
      }
    }
  }

  // The repair file's baseline must EXACTLY equal the derived set.
  const inputSet = new Set(input.baselinePulseIds);
  const derivedSet = new Set(snapshot.derivedBaselinePulseIds);
  for (const pid of derivedSet) {
    if (!inputSet.has(pid)) {
      errors.push(
        `Baseline omits provable pulse ${pid}; omitting an already-proven Pulse enables a future false recurrence`,
      );
    }
  }
  for (const pid of inputSet) {
    if (!derivedSet.has(pid)) {
      errors.push(
        `Baseline includes pulse ${pid} which is not provable for this identity (nonexistent or foreign)`,
      );
    }
  }

  // Cutoff: parseable and not in the future. Semantics: post-reset recurrence
  // requires a Pulse created strictly after the cutoff AND absent from the baseline.
  const cutoffMs = Date.parse(input.cutoffTimestamp ?? "");
  if (Number.isNaN(cutoffMs)) {
    errors.push(`Cutoff timestamp is not parseable as ISO-8601: ${input.cutoffTimestamp}`);
  } else if (cutoffMs > Date.now()) {
    errors.push(`Cutoff timestamp is in the future: ${input.cutoffTimestamp}`);
  }

  // The derived canonical chain must satisfy every edge invariant (terminal,
  // canonically older; self/branch/cycle are impossible by construction but
  // checked anyway), and the canonical root must be the canonically oldest
  // member — otherwise the derived chain would not start at the requested root.
  const ordered = orderMembersCanonically(snapshot.rows);
  if (ordered.length > 0 && ordered[0].id !== input.canonicalRootId) {
    errors.push(
      `Canonical root ${input.canonicalRootId} is not the canonically oldest member (${ordered[0].id} is)`,
    );
  }
  validateLinearChain(deriveAfterMapping(input, snapshot), byId, errors);

  return errors;
}

// Pulse existence lookup runs on the SAME supplied client as the rest of
// derive+validate (the maintenance reservation covers it too).
function lookupPulses(client: DbClient, pulseIds: string[]): { id: string; habitatId: string }[] {
  return client
    .select({ id: pulsesTable.id, habitatId: pulsesTable.habitatId })
    .from(pulsesTable)
    .where(inArray(pulsesTable.id, pulseIds))
    .all() as { id: string; habitatId: string }[];
}

// ─── Preview / apply ───────────────────────────────────────────────────

/**
 * Preview a repair without applying it. Derives the identity snapshot,
 * validates all invariants against the DERIVED state, and returns the stable
 * repair-file digest that apply will verify.
 */
export function previewRepair(input: RepairInput, client: DbClient = getDb()): RepairPreview {
  const snapshot = deriveIdentitySnapshot(client, input);
  const validationErrors = validateRepair(input, snapshot, client);
  const beforeStateDigest = computeBeforeStateDigest(snapshot);
  const digest = computeRepairFileDigest(input, beforeStateDigest);

  return {
    mode: input.mode,
    habitatId: input.habitatId,
    clusterKey: input.clusterKey,
    findingKind: input.findingKind,
    digest,
    beforeStateDigest,
    beforeMapping: snapshot.beforeMapping,
    afterMapping: deriveAfterMapping(input, snapshot),
    baselinePulseIds:
      input.mode === "evidence_baselined_root" ? snapshot.derivedBaselinePulseIds : undefined,
    cutoffTimestamp: input.mode === "evidence_baselined_root" ? input.cutoffTimestamp : undefined,
    validationErrors,
    canApply: validationErrors.length === 0,
  };
}

/**
 * Apply a repair. Requirements:
 * - Operator identity and reason must be provided
 * - A verified maintenance session (lock file held + backup verified)
 * - The digest from preview must match (database hasn't changed)
 * - Runs derive+validate+mutate+ledger inside BEGIN EXCLUSIVE — the
 *   reservation is acquired FIRST and the snapshot is re-derived AFTER it,
 *   so a mutation between preview and apply is rejected (TOCTOU-safe)
 *
 * Replay semantics: an exact repair-file digest already present in the
 * ledger returns the ORIGINAL result with no new writes (one audit row). A
 * changed file produces a different digest and conflicts.
 *
 * The maintenance session is released when applyRepair returns or throws.
 * Throws RepairValidationError if prerequisites are not met.
 */
export function applyRepair(
  input: RepairInput,
  expectedDigest: string,
  maintenance: MaintenanceSession,
  client: DbClient = getDb(),
): RepairApplyResult {
  if (!input.operator?.id || !input.operator?.reason) {
    throw new RepairValidationError(
      "Operator identity and reason are required",
      "missing_operator",
    );
  }
  if (!maintenance || maintenance.released) {
    throw new RepairValidationError(
      "An active maintenance session (verified lock + verified backup) is required",
      "missing_maintenance_session",
    );
  }

  try {
    return client.transaction(
      () => {
        // BEGIN EXCLUSIVE is now held — the database is quiesced. Re-verify
        // the backup under quiescence before touching anything.
        reverifyBackupUnderQuiesce(maintenance);

        // Exact replay: this digest is recorded in the ledger. Before
        // trusting it, VERIFY the supplied input actually hashes to it —
        // reconstruct the before-state the file was prepared against by
        // reverting recurrence links to the ledger's beforeMapping (the
        // only columns the repair itself mutated). A changed file claiming
        // an applied digest conflicts instead of replaying.
        const existing = checkExistingRepair(expectedDigest, client);
        if (existing.exists && existing.repairId) {
          const snapshotNow = deriveIdentitySnapshot(client, input);
          const recordedBefore = (existing.beforeMapping ?? {}) as Record<string, string | null>;
          const reconstructed: DerivedRepairSnapshot = {
            ...snapshotNow,
            rows: snapshotNow.rows.map((r) => ({
              ...r,
              recurrenceOfId: recordedBefore[r.id] !== undefined ? recordedBefore[r.id] : null,
            })),
            beforeMapping: recordedBefore,
          };
          const candidate = computeRepairFileDigest(input, computeBeforeStateDigest(reconstructed));
          if (candidate !== expectedDigest) {
            throw new RepairValidationError(
              `Repair-file conflict: digest ${expectedDigest} is recorded, but the supplied input does not hash to it (changed content or post-repair identity drift — re-preview for a fresh repair file).`,
              "repair_file_conflict",
            );
          }
          return {
            repairId: existing.repairId,
            mode: input.mode,
            appliedAt: existing.appliedAt ?? new Date().toISOString(),
            digest: expectedDigest,
            replayed: true,
          };
        }

        // Re-derive AFTER the reservation (TOCTOU guard): any mutation
        // committed between preview and this BEGIN is now visible.
        const snapshot = deriveIdentitySnapshot(client, input);
        const beforeStateDigest = computeBeforeStateDigest(snapshot);
        const fileDigest = computeRepairFileDigest(input, beforeStateDigest);
        if (fileDigest !== expectedDigest) {
          throw new RepairValidationError(
            `Digest drift: expected ${expectedDigest}, got ${fileDigest}. The database (or the repair file content) changed between preview and apply.`,
            "digest_drift",
          );
        }

        const validationErrors = validateRepair(input, snapshot, client);
        if (validationErrors.length > 0) {
          throw new RepairValidationError(
            `Validation errors: ${validationErrors.join("; ")}`,
            "validation_failed",
          );
        }

        // Every check has passed — mutate, ledger, and only now clear the
        // quarantine flag (same statements, same transaction).
        const repairId = uuid();
        const now = new Date().toISOString();
        const afterMapping = deriveAfterMapping(input, snapshot);
        for (const [childId, predId] of Object.entries(afterMapping)) {
          client.run(
            sql`UPDATE finding_triage
                SET recurrence_of_id = ${predId},
                    legacy_lineage_repair_required = 0,
                    updated_at = ${now}
                WHERE id = ${childId}`,
          );
        }

        client
          .insert(findingTriageLineageRepairs)
          .values({
            id: repairId,
            habitatId: input.habitatId,
            clusterKey: input.clusterKey,
            findingKind: input.findingKind,
            mode: input.mode,
            affectedIdentity: `${input.habitatId}/${input.clusterKey}/${input.findingKind}`,
            actorType: input.operator.type,
            actorId: input.operator.id,
            reason: input.operator.reason,
            beforeMapping: snapshot.beforeMapping,
            afterMapping,
            inputSnapshotDigest: fileDigest,
            cutoffTimestamp:
              input.mode === "evidence_baselined_root" ? input.cutoffTimestamp : null,
          })
          .run();

        if (input.mode === "evidence_baselined_root") {
          for (const pulseId of input.baselinePulseIds) {
            client.run(
              sql`INSERT OR IGNORE INTO finding_triage_lineage_baseline_evidence
                  (repair_id, pulse_id, digest)
                  VALUES (${repairId}, ${pulseId}, ${fileDigest})`,
            );
          }
        }

        return {
          repairId,
          mode: input.mode,
          appliedAt: now,
          digest: fileDigest,
          replayed: false,
        };
      },
      { behavior: "exclusive" },
    );
  } finally {
    maintenance.release();
  }
}

/**
 * Idempotent replay check, wired into applyRepair: looks up a ledger row by
 * repair-file digest (returning the recorded beforeMapping so apply can
 * verify the supplied input genuinely hashes to the digest). Exported for
 * operator tooling ("was this exact file already applied?").
 */
export function checkExistingRepair(
  digest: string,
  client: DbClient = getDb(),
): {
  exists: boolean;
  repairId: string | null;
  appliedAt: string | null;
  beforeMapping: Record<string, string | null> | null;
} {
  const row = client
    .select({
      id: findingTriageLineageRepairs.id,
      repairTime: findingTriageLineageRepairs.repairTime,
      beforeMapping: findingTriageLineageRepairs.beforeMapping,
    })
    .from(findingTriageLineageRepairs)
    .where(eq(findingTriageLineageRepairs.inputSnapshotDigest, digest))
    .get();
  return {
    exists: !!row,
    repairId: row?.id ?? null,
    appliedAt: row?.repairTime ?? null,
    beforeMapping: (row?.beforeMapping as Record<string, string | null>) ?? null,
  };
}
