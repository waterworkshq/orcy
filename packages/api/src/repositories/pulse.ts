import { getDb } from "../db/index.js";
import { pulses, pulseCursors } from "../db/schema/index.js";
import { eq, and, or, gt, gte, lte, count, desc, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
  repositoryUpsertError,
} from "../errors/repository.js";
import { SIGNAL_TYPES, type SignalType } from "@orcy/shared";

export { type SignalType };

export type PulseScope = "mission" | "habitat";

export interface Pulse {
  id: string;
  missionId: string | null;
  habitatId: string;
  scope: PulseScope;
  fromType: "human" | "agent" | "system" | "remote_human" | "remote_orcy";
  fromId: string;
  toType: "human" | "agent" | "remote_human" | "remote_orcy" | null;
  toId: string | null;
  signalType: SignalType;
  subject: string;
  body: string;
  taskId: string | null;
  replyToId: string | null;
  linkedTaskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  pinned: number;
  isAuto: boolean;
}

export interface CreatePulseInput {
  missionId?: string;
  habitatId: string;
  scope?: PulseScope;
  fromType: "human" | "agent" | "system" | "remote_human" | "remote_orcy";
  fromId: string;
  toType?: "human" | "agent" | "remote_human" | "remote_orcy";
  toId?: string;
  signalType: SignalType;
  subject: string;
  body?: string;
  taskId?: string;
  replyToId?: string;
  linkedTaskId?: string;
  metadata?: Record<string, unknown>;
  isAuto?: boolean;
}

export interface PulseDigest {
  summary: string;
  newSinceLastCheck: number;
  counts: Record<SignalType, number>;
  highlights: Array<{
    id: string;
    signalType: SignalType;
    from: { type: string; name: string };
    subject: string;
    linkedTaskId?: string;
    createdAt: string;
  }>;
}

export interface PulseFilters {
  signalType?: SignalType;
  signalTypes?: SignalType[];
  scope?: PulseScope;
  taskId?: string;
  isAuto?: boolean;
  since?: string;
  limit?: number;
  offset?: number;
}

/**
 * Filters for {@link listFindings}. `structured` toggles between structured findings
 * (`metadata->>'$.findingKind' IS NOT NULL`) and free-form findings (`IS NULL`); `undefined`
 * returns both. `findingKind` and `severity` apply JSON-extracted equality filters (ADR-0010).
 * `timeWindow` is a duration string (`'7 days'`, `'30 days'`) parsed into an ISO timestamp.
 */
export interface FindingFilters {
  structured?: boolean;
  findingKind?: string;
  severity?: string;
  timeWindow?: string;
  limit?: number;
  offset?: number;
}

/**
 * Parses a duration string (e.g. `'7 days'`, `'30 days'`, `'90 days'`) into an ISO timestamp
 * representing `now - duration`. Returns `null` for unparseable input so the caller can skip
 * the filter rather than silently widen the window. Mirrors the habitat-skill helper.
 */
function parseDurationWindow(
  timeWindow: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!timeWindow) return null;
  const match = timeWindow
    .trim()
    .match(/^(\d+)\s*(s|sec|seconds?|m|min|mins?|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  let ms: number;
  if (unit.startsWith("s")) ms = n * 1000;
  else if (unit.startsWith("m") && !unit.startsWith("ms")) ms = n * 60 * 1000;
  else if (unit.startsWith("h")) ms = n * 60 * 60 * 1000;
  else if (unit.startsWith("d")) ms = n * 24 * 60 * 60 * 1000;
  else if (unit.startsWith("w")) ms = n * 7 * 24 * 60 * 60 * 1000;
  else return null;
  return new Date(now.getTime() - ms).toISOString();
}

function rowToPulse(row: Record<string, unknown>): Pulse {
  // drizzle's RETURNING (INSERT) and select() can return different key
  // casings — RETURNING uses camelCase (the schema property names) while
  // select() uses snake_case (the column names). Read both.
  const get = (snake: string, camel: string): unknown => row[snake] ?? row[camel];
  return {
    id: get("id", "id") as string,
    missionId: (get("mission_id", "missionId") as string | null) ?? null,
    habitatId: get("habitat_id", "habitatId") as string,
    scope: (get("scope", "scope") as PulseScope) ?? "mission",
    fromType: get("from_type", "fromType") as
      | "human"
      | "agent"
      | "system"
      | "remote_human"
      | "remote_orcy",
    fromId: get("from_id", "fromId") as string,
    toType:
      (get("to_type", "toType") as "human" | "agent" | "remote_human" | "remote_orcy" | null) ??
      null,
    toId: (get("to_id", "toId") as string | null) ?? null,
    signalType: get("signal_type", "signalType") as SignalType,
    subject: get("subject", "subject") as string,
    body: get("body", "body") as string,
    taskId: (get("task_id", "taskId") as string | null) ?? null,
    replyToId: (get("reply_to_id", "replyToId") as string | null) ?? null,
    linkedTaskId: (get("linked_task_id", "linkedTaskId") as string | null) ?? null,
    metadata: (get("metadata", "metadata") as Record<string, unknown>) ?? {},
    createdAt: get("created_at", "createdAt") as string,
    pinned: get("pinned", "pinned") as number,
    isAuto: (get("is_auto", "isAuto") as boolean) ?? false,
  };
}

const ALL_SIGNAL_TYPES = SIGNAL_TYPES;

function pluralSignalLabel(type: SignalType): string {
  if (type === "experience") return "experiences";
  if (type === "context") return "context";
  return `${type}s`;
}

function formatPulseCountSummary(counts: Record<SignalType, number>, emptyText: string): string {
  const totalSignals = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalSignals === 0) return emptyText;
  const parts = ALL_SIGNAL_TYPES.filter((type) => counts[type] > 0).map(
    (type) => `${counts[type]} ${pluralSignalLabel(type)}`,
  );
  return `${totalSignals} ${totalSignals === 1 ? "signal" : "signals"}: ${parts.join(", ")}.`;
}

function stuckExperienceCondition() {
  return and(
    eq(pulses.signalType, "experience"),
    sql`json_extract(${pulses.metadata}, '$.experience') = 'stuck'`,
  );
}

export function createPulse(input: CreatePulseInput): Pulse {
  const scope = input.scope ?? "mission";

  if (scope === "mission" && !input.missionId) {
    throw new Error("missionId is required for mission-scoped signals");
  }
  if (scope === "habitat" && input.missionId) {
    throw new Error("missionId must not be provided for habitat-scoped signals");
  }
  if (scope === "habitat" && !input.habitatId) {
    throw new Error("habitatId is required for habitat-scoped signals");
  }

  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  let rows;
  try {
    rows = db
      .insert(pulses)
      .values({
        id,
        missionId: input.missionId ?? null,
        habitatId: input.habitatId,
        scope,
        fromType: input.fromType,
        fromId: input.fromId,
        toType: input.toType ?? null,
        toId: input.toId ?? null,
        signalType: input.signalType,
        subject: input.subject,
        body: input.body ?? "",
        taskId: input.taskId ?? null,
        replyToId: input.replyToId ?? null,
        linkedTaskId: input.linkedTaskId ?? null,
        metadata: input.metadata ?? {},
        createdAt: now,
        pinned: 0,
        isAuto: input.isAuto ?? false,
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError("pulse", err as Error, id);
  }

  if (rows.length > 0) return rowToPulse(rows[0]);
  const pulse = getPulseById(id);
  if (!pulse) throw repositoryNotFoundError("pulse", id);
  return pulse;
}

export function getPulseById(id: string): Pulse | null {
  const db = getDb();
  const rows = db.select().from(pulses).where(eq(pulses.id, id)).all();
  return rows.length > 0 ? rowToPulse(rows[0]) : null;
}

export function getPulsesByMission(
  missionId: string,
  filters?: PulseFilters,
): { pulses: Pulse[]; total: number } {
  const db = getDb();
  const conditions = [eq(pulses.missionId, missionId), eq(pulses.scope, "mission")];

  if (filters?.signalTypes && filters.signalTypes.length > 0) {
    conditions.push(inArray(pulses.signalType, filters.signalTypes));
  } else if (filters?.signalType) {
    conditions.push(eq(pulses.signalType, filters.signalType));
  }
  if (filters?.isAuto !== undefined) {
    conditions.push(eq(pulses.isAuto, filters.isAuto));
  }
  if (filters?.taskId) {
    conditions.push(eq(pulses.taskId, filters.taskId));
  }
  if (filters?.since) {
    conditions.push(gt(pulses.createdAt, filters.since));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(pulses).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db
    .select()
    .from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt), desc(pulses.id))
    .limit(limit)
    .offset(offset)
    .all();

  return { pulses: rows.map(rowToPulse), total };
}

export function getPulsesByHabitat(
  habitatId: string,
  filters?: PulseFilters,
): { pulses: Pulse[]; total: number } {
  const db = getDb();
  const conditions = [eq(pulses.habitatId, habitatId)];

  if (filters?.scope) {
    conditions.push(eq(pulses.scope, filters.scope));
  }
  if (filters?.signalTypes && filters.signalTypes.length > 0) {
    conditions.push(inArray(pulses.signalType, filters.signalTypes));
  } else if (filters?.signalType) {
    conditions.push(eq(pulses.signalType, filters.signalType));
  }
  if (filters?.isAuto !== undefined) {
    conditions.push(eq(pulses.isAuto, filters.isAuto));
  }
  if (filters?.taskId) {
    conditions.push(eq(pulses.taskId, filters.taskId));
  }
  if (filters?.since) {
    conditions.push(gt(pulses.createdAt, filters.since));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(pulses).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db
    .select()
    .from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt), desc(pulses.id))
    .limit(limit)
    .offset(offset)
    .all();

  return { pulses: rows.map(rowToPulse), total };
}

export function getPulsesByTarget(
  targetType: "human" | "agent",
  targetId: string,
  filters?: PulseFilters,
): { pulses: Pulse[]; total: number } {
  const db = getDb();
  const conditions = [eq(pulses.toType, targetType), eq(pulses.toId, targetId)];

  if (filters?.signalTypes && filters.signalTypes.length > 0) {
    conditions.push(inArray(pulses.signalType, filters.signalTypes));
  } else if (filters?.signalType) {
    conditions.push(eq(pulses.signalType, filters.signalType));
  }
  if (filters?.since) {
    conditions.push(gt(pulses.createdAt, filters.since));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(pulses).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db
    .select()
    .from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt), desc(pulses.id))
    .limit(limit)
    .offset(offset)
    .all();

  return { pulses: rows.map(rowToPulse), total };
}

export function getPulseCountsByMission(missionId: string): Record<SignalType, number> {
  const db = getDb();
  const counts: Record<string, number> = {};
  for (const t of ALL_SIGNAL_TYPES) {
    counts[t] = 0;
  }

  const rows = db
    .select({
      signalType: pulses.signalType,
      total: count(),
    })
    .from(pulses)
    .where(and(eq(pulses.missionId, missionId), eq(pulses.scope, "mission")))
    .groupBy(pulses.signalType)
    .all();

  for (const row of rows) {
    counts[row.signalType] = row.total;
  }

  return counts as Record<SignalType, number>;
}

export function getNewPulseCount(missionId: string, since: string): number {
  const db = getDb();
  const rows = db
    .select({ total: count() })
    .from(pulses)
    .where(
      and(
        eq(pulses.missionId, missionId),
        eq(pulses.scope, "mission"),
        gt(pulses.createdAt, since),
      ),
    )
    .all();
  return rows[0]?.total ?? 0;
}

export function getHighlightPulses(
  missionId: string,
  readerType?: "human" | "agent",
  readerId?: string,
): Pulse[] {
  const db = getDb();
  const missionEq = and(eq(pulses.missionId, missionId), eq(pulses.scope, "mission"));

  const highlightTypes = or(
    eq(pulses.signalType, "directive"),
    eq(pulses.signalType, "blocker"),
    stuckExperienceCondition(),
  );

  if (readerType && readerId) {
    const targeting = and(
      or(eq(pulses.signalType, "directive"), eq(pulses.signalType, "blocker")),
      eq(pulses.toType, readerType),
      eq(pulses.toId, readerId),
    );
    const where = and(missionEq, or(highlightTypes, targeting));
    const rows = db
      .select()
      .from(pulses)
      .where(where)
      .orderBy(desc(pulses.createdAt))
      .limit(20)
      .all();
    return rows.map(rowToPulse);
  }

  const where = and(missionEq, highlightTypes);
  const rows = db
    .select()
    .from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt))
    .limit(20)
    .all();

  return rows.map(rowToPulse);
}

export function getLatestSummaryPulse(missionId: string): Pulse | null {
  const db = getDb();
  const rows = db
    .select()
    .from(pulses)
    .where(
      and(eq(pulses.missionId, missionId), eq(pulses.scope, "mission"), eq(pulses.isAuto, false)),
    )
    .orderBy(desc(pulses.createdAt))
    .limit(1)
    .all();

  return rows.length > 0 ? rowToPulse(rows[0]) : null;
}

export function deletePulse(id: string): boolean {
  const db = getDb();
  const pulse = getPulseById(id);
  if (!pulse) return false;
  try {
    db.delete(pulses).where(eq(pulses.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("pulse", err as Error, id);
  }
  return true;
}

export function getCursor(
  scopeKey: string,
  readerType: "human" | "agent",
  readerId: string,
): string | null {
  const db = getDb();
  const rows = db
    .select()
    .from(pulseCursors)
    .where(
      and(
        eq(pulseCursors.scopeKey, scopeKey),
        eq(pulseCursors.readerType, readerType),
        eq(pulseCursors.readerId, readerId),
      ),
    )
    .all();
  return rows.length > 0 ? (rows[0].lastCheckedAt ?? null) : null;
}

export function updateCursor(
  scopeKey: string,
  readerType: "human" | "agent",
  readerId: string,
  scope: PulseScope = "mission",
): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.insert(pulseCursors)
      .values({ scopeKey, scope, readerType, readerId, lastCheckedAt: now })
      .onConflictDoUpdate({
        target: [pulseCursors.scopeKey, pulseCursors.readerType, pulseCursors.readerId],
        set: { lastCheckedAt: now },
      })
      .run();
  } catch (err) {
    throw repositoryUpsertError(
      "pulseCursor",
      err as Error,
      `${scopeKey}:${readerType}:${readerId}`,
    );
  }
}

export function getReplies(pulseId: string): Pulse[] {
  const db = getDb();
  const rows = db
    .select()
    .from(pulses)
    .where(eq(pulses.replyToId, pulseId))
    .orderBy(desc(pulses.createdAt))
    .all();
  return rows.map(rowToPulse);
}

export function updateLinkedTask(pulseId: string, taskId: string): void {
  const db = getDb();
  try {
    db.update(pulses).set({ linkedTaskId: taskId }).where(eq(pulses.id, pulseId)).run();
  } catch (err) {
    throw repositoryUpdateError("pulse", err as Error, pulseId);
  }
}

export function getPulseDigest(
  missionId: string,
  readerType: "human" | "agent",
  readerId: string,
): PulseDigest {
  const cursor = getCursor(missionId, readerType, readerId);
  const sinceEpoch = cursor ?? "1970-01-01T00:00:00.000Z";

  const newSinceLastCheck = getNewPulseCount(missionId, sinceEpoch);
  const counts = getPulseCountsByMission(missionId);
  const highlightPulses = getHighlightPulses(missionId, readerType, readerId);
  const summary = formatPulseCountSummary(counts, "No signals yet.");

  const highlights = highlightPulses.map((p) => ({
    id: p.id,
    signalType: p.signalType,
    from: { type: p.fromType, name: p.fromId },
    subject: p.subject,
    linkedTaskId: p.linkedTaskId ?? undefined,
    createdAt: p.createdAt,
  }));

  updateCursor(missionId, readerType, readerId, "mission");

  return {
    summary,
    newSinceLastCheck,
    counts,
    highlights,
  };
}

/**
 * Returns the latest pulses in a habitat with `createdAt > since` (delta/chunk mode for
 * `wikiAugmentationService`). `limit` defaults to 100, ordered newest-first by `createdAt`.
 * Bypasses the standard `PulseFilters` path because that one couples to a habitat query key
 * (not a raw ISO timestamp) and the augmentation service needs a stable, no-paging signature.
 * No side effects.
 */
export function listByHabitatSince(habitatId: string, since: string, limit = 100): Pulse[] {
  const db = getDb();
  const rows = db
    .select()
    .from(pulses)
    .where(and(eq(pulses.habitatId, habitatId), gt(pulses.createdAt, since)))
    .orderBy(desc(pulses.createdAt), desc(pulses.id))
    .limit(limit)
    .all();
  return rows.map(rowToPulse);
}

/**
 * Returns pulses in a habitat with `created_at` in the inclusive window `[from, to]`, ordered
 * newest-first. Backs the `wikiAugmentationService` chunk mode so old bootstrap chunks in active
 * habitats return the rows actually in the window, instead of the newest `limit*4` since 1970
 * filtered in memory (which crowded out historical rows). `limit` defaults to 100. No side
 * effects.
 */
export function listByHabitatBetween(
  habitatId: string,
  from: string,
  to: string,
  limit = 100,
): Pulse[] {
  const db = getDb();
  const rows = db
    .select()
    .from(pulses)
    .where(
      and(eq(pulses.habitatId, habitatId), gte(pulses.createdAt, from), lte(pulses.createdAt, to)),
    )
    .orderBy(desc(pulses.createdAt), desc(pulses.id))
    .limit(limit)
    .all();
  return rows.map(rowToPulse);
}

export function getHabitatPulseDigest(
  habitatId: string,
  readerType: "human" | "agent",
  readerId: string,
): PulseDigest {
  const cursor = getCursor(habitatId, readerType, readerId);
  const sinceEpoch = cursor ?? "1970-01-01T00:00:00.000Z";

  const db = getDb();
  const newRows = db
    .select({ total: count() })
    .from(pulses)
    .where(
      and(
        eq(pulses.habitatId, habitatId),
        eq(pulses.scope, "habitat"),
        gt(pulses.createdAt, sinceEpoch),
      ),
    )
    .all();
  const newSinceLastCheck = newRows[0]?.total ?? 0;

  const counts: Record<string, number> = {};
  for (const t of ALL_SIGNAL_TYPES) counts[t] = 0;
  const typeRows = db
    .select({
      signalType: pulses.signalType,
      total: count(),
    })
    .from(pulses)
    .where(and(eq(pulses.habitatId, habitatId), eq(pulses.scope, "habitat")))
    .groupBy(pulses.signalType)
    .all();
  for (const row of typeRows) counts[row.signalType] = row.total;

  const highlightTypes = or(
    eq(pulses.signalType, "directive"),
    eq(pulses.signalType, "blocker"),
    stuckExperienceCondition(),
  );

  let highlightRows;
  if (readerType && readerId) {
    const targeting = and(
      or(eq(pulses.signalType, "directive"), eq(pulses.signalType, "blocker")),
      eq(pulses.toType, readerType),
      eq(pulses.toId, readerId),
    );
    highlightRows = db
      .select()
      .from(pulses)
      .where(
        and(
          eq(pulses.habitatId, habitatId),
          eq(pulses.scope, "habitat"),
          or(highlightTypes, targeting),
        ),
      )
      .orderBy(desc(pulses.createdAt))
      .limit(20)
      .all();
  } else {
    highlightRows = db
      .select()
      .from(pulses)
      .where(and(eq(pulses.habitatId, habitatId), eq(pulses.scope, "habitat"), highlightTypes))
      .orderBy(desc(pulses.createdAt))
      .limit(20)
      .all();
  }

  const highlights = highlightRows
    .map((p) => rowToPulse(p))
    .map((p) => ({
      id: p.id,
      signalType: p.signalType,
      from: { type: p.fromType, name: p.fromId },
      subject: p.subject,
      linkedTaskId: p.linkedTaskId ?? undefined,
      createdAt: p.createdAt,
    }));

  const summary = formatPulseCountSummary(
    counts as Record<SignalType, number>,
    "No habitat signals yet.",
  );

  updateCursor(habitatId, readerType, readerId, "habitat");

  return {
    summary,
    newSinceLastCheck,
    counts: counts as Record<SignalType, number>,
    highlights,
  };
}

/**
 * Returns finding pulses in a habitat, optionally filtered by structure / kind / severity /
 * recency. Backed by the `pulses` table with `signalType = 'finding'` and
 * `metadata->>'$.findingKind'` JSON extraction (ADR-0010 layered opt-in convention).
 *
 * `structured: true` matches rows where `findingKind IS NOT NULL` (fully-formed engineering
 * findings); `structured: false` matches free-form findings (`IS NULL`). When `undefined`,
 * both kinds are returned.
 *
 * No privacy gate on findings — individual rows are returned with `createdBy` (`fromType` +
 * `fromId`) so readers can attribute observations. See ARCHITECTURE.md §11.7.
 */
export function listFindings(habitatId: string, filters: FindingFilters = {}): Pulse[] {
  const db = getDb();
  const conditions = [eq(pulses.habitatId, habitatId), eq(pulses.signalType, "finding")];

  if (filters.structured === true) {
    conditions.push(sql`json_extract(${pulses.metadata}, '$.findingKind') IS NOT NULL`);
  } else if (filters.structured === false) {
    conditions.push(sql`json_extract(${pulses.metadata}, '$.findingKind') IS NULL`);
  }
  if (filters.findingKind !== undefined) {
    conditions.push(
      sql`json_extract(${pulses.metadata}, '$.findingKind') = ${filters.findingKind}`,
    );
  }
  if (filters.severity !== undefined) {
    conditions.push(sql`json_extract(${pulses.metadata}, '$.severity') = ${filters.severity}`);
  }

  const sinceIso = parseDurationWindow(filters.timeWindow);
  if (sinceIso) {
    conditions.push(gt(pulses.createdAt, sinceIso));
  }

  const where = and(...conditions);

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const rows = db
    .select()
    .from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt), desc(pulses.id))
    .limit(limit)
    .offset(offset)
    .all();

  return rows.map(rowToPulse);
}
