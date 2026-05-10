import { getDb } from '../db/index.js';
import { pulses, pulseCursors } from '../db/schema.js';
import { eq, and, or, lt, gt, count, desc, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export type SignalType =
  | 'finding' | 'blocker' | 'offer' | 'warning'
  | 'question' | 'answer' | 'directive' | 'context' | 'handoff';

export interface Pulse {
  id: string;
  missionId: string;
  boardId: string;
  fromType: 'human' | 'agent' | 'system';
  fromId: string;
  toType: 'human' | 'agent' | null;
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
  missionId: string;
  boardId: string;
  fromType: 'human' | 'agent' | 'system';
  fromId: string;
  toType?: 'human' | 'agent';
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
  isAuto?: boolean;
  since?: string;
  limit?: number;
  offset?: number;
}

function rowToPulse(row: Record<string, unknown>): Pulse {
  return {
    id: row.id as string,
    missionId: row.mission_id as string,
    boardId: row.board_id as string,
    fromType: row.from_type as 'human' | 'agent' | 'system',
    fromId: row.from_id as string,
    toType: (row.to_type as 'human' | 'agent' | null) ?? null,
    toId: (row.to_id as string | null) ?? null,
    signalType: row.signal_type as SignalType,
    subject: row.subject as string,
    body: row.body as string,
    taskId: (row.task_id as string | null) ?? null,
    replyToId: (row.reply_to_id as string | null) ?? null,
    linkedTaskId: (row.linked_task_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
    pinned: row.pinned as number,
    isAuto: (row.is_auto as boolean) ?? false,
  };
}

const ALL_SIGNAL_TYPES: SignalType[] = [
  'finding', 'blocker', 'offer', 'warning',
  'question', 'answer', 'directive', 'context', 'handoff',
];

export function createPulse(input: CreatePulseInput): Pulse {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(pulses).values({
    id,
    missionId: input.missionId,
    boardId: input.boardId,
    fromType: input.fromType,
    fromId: input.fromId,
    toType: input.toType ?? null,
    toId: input.toId ?? null,
    signalType: input.signalType,
    subject: input.subject,
    body: input.body ?? '',
    taskId: input.taskId ?? null,
    replyToId: input.replyToId ?? null,
    linkedTaskId: input.linkedTaskId ?? null,
    metadata: input.metadata ?? {},
    createdAt: now,
    pinned: 0,
    isAuto: input.isAuto ?? false,
  }).run();

  return getPulseById(id)!;
}

export function getPulseById(id: string): Pulse | null {
  const db = getDb();
  const rows = db.select().from(pulses).where(eq(pulses.id, id)).all();
  return rows.length > 0 ? rowToPulse(rows[0]) : null;
}

export function getPulsesByMission(
  missionId: string,
  filters?: PulseFilters
): { pulses: Pulse[]; total: number } {
  const db = getDb();
  const conditions = [eq(pulses.missionId, missionId)];

  if (filters?.signalType) {
    conditions.push(eq(pulses.signalType, filters.signalType));
  }
  if (filters?.isAuto !== undefined) {
    conditions.push(eq(pulses.isAuto, filters.isAuto));
  }
  if (filters?.since) {
    conditions.push(gt(pulses.createdAt, filters.since));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(pulses).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db.select().from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { pulses: rows.map(rowToPulse), total };
}

export function getPulsesByTarget(
  targetType: 'human' | 'agent',
  targetId: string,
  filters?: PulseFilters
): { pulses: Pulse[]; total: number } {
  const db = getDb();
  const conditions = [
    eq(pulses.toType, targetType),
    eq(pulses.toId, targetId),
  ];

  if (filters?.signalType) {
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

  const rows = db.select().from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt))
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

  const rows = db.select({
    signalType: pulses.signalType,
    total: count(),
  }).from(pulses)
    .where(eq(pulses.missionId, missionId))
    .groupBy(pulses.signalType)
    .all();

  for (const row of rows) {
    counts[row.signalType] = row.total;
  }

  return counts as Record<SignalType, number>;
}

export function getNewPulseCount(missionId: string, since: string): number {
  const db = getDb();
  const rows = db.select({ total: count() }).from(pulses).where(
    and(
      eq(pulses.missionId, missionId),
      gt(pulses.createdAt, since)
    )
  ).all();
  return rows[0]?.total ?? 0;
}

export function getHighlightPulses(
  missionId: string,
  readerType?: 'human' | 'agent',
  readerId?: string
): Pulse[] {
  const db = getDb();
  const missionEq = eq(pulses.missionId, missionId);

  const highlightConditions = [
    eq(pulses.signalType, 'directive'),
    eq(pulses.signalType, 'blocker'),
  ] as const;

  if (readerType && readerId) {
    const targeting = and(eq(pulses.toType, readerType), eq(pulses.toId, readerId));
    const where = and(missionEq, or(...highlightConditions, targeting));
    const rows = db.select().from(pulses)
      .where(where)
      .orderBy(desc(pulses.createdAt))
      .limit(20)
      .all();
    return rows.map(rowToPulse);
  }

  const where = and(missionEq, or(...highlightConditions));
  const rows = db.select().from(pulses)
    .where(where)
    .orderBy(desc(pulses.createdAt))
    .limit(20)
    .all();

  return rows.map(rowToPulse);
}

export function getLatestSummaryPulse(missionId: string): Pulse | null {
  const db = getDb();
  const rows = db.select().from(pulses).where(
    and(
      eq(pulses.missionId, missionId),
      eq(pulses.isAuto, false)
    )
  ).orderBy(desc(pulses.createdAt))
    .limit(1)
    .all();

  return rows.length > 0 ? rowToPulse(rows[0]) : null;
}

export function deletePulse(id: string): boolean {
  const db = getDb();
  const pulse = getPulseById(id);
  if (!pulse) return false;
  db.delete(pulses).where(eq(pulses.id, id)).run();
  return true;
}

export function getCursor(
  missionId: string,
  readerType: 'human' | 'agent',
  readerId: string
): string | null {
  const db = getDb();
  const rows = db.select().from(pulseCursors).where(
    and(
      eq(pulseCursors.missionId, missionId),
      eq(pulseCursors.readerType, readerType),
      eq(pulseCursors.readerId, readerId)
    )
  ).all();
  return rows.length > 0 ? (rows[0].lastCheckedAt ?? null) : null;
}

export function updateCursor(
  missionId: string,
  readerType: 'human' | 'agent',
  readerId: string
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getCursor(missionId, readerType, readerId);

  if (existing) {
    db.update(pulseCursors).set({ lastCheckedAt: now }).where(
      and(
        eq(pulseCursors.missionId, missionId),
        eq(pulseCursors.readerType, readerType),
        eq(pulseCursors.readerId, readerId)
      )
    ).run();
  } else {
    db.insert(pulseCursors).values({
      missionId,
      readerType,
      readerId,
      lastCheckedAt: now,
    }).run();
  }
}

export function getReplies(pulseId: string): Pulse[] {
  const db = getDb();
  const rows = db.select().from(pulses)
    .where(eq(pulses.replyToId, pulseId))
    .orderBy(desc(pulses.createdAt))
    .all();
  return rows.map(rowToPulse);
}

export function updateLinkedTask(pulseId: string, taskId: string): void {
  const db = getDb();
  db.update(pulses).set({ linkedTaskId: taskId }).where(eq(pulses.id, pulseId)).run();
}

export function getPulseDigest(
  missionId: string,
  readerType: 'human' | 'agent',
  readerId: string
): PulseDigest {
  const cursor = getCursor(missionId, readerType, readerId);
  const sinceEpoch = cursor ?? '1970-01-01T00:00:00.000Z';

  const newSinceLastCheck = getNewPulseCount(missionId, sinceEpoch);
  const counts = getPulseCountsByMission(missionId);
  const highlightPulses = getHighlightPulses(missionId, readerType, readerId);
  const latestPulse = getLatestSummaryPulse(missionId);

  const totalSignals = Object.values(counts).reduce((a, b) => a + b, 0);
  const otherCount = latestPulse ? Math.max(0, totalSignals - (counts[latestPulse.signalType] ?? 0)) : 0;
  const summary = latestPulse
    ? `${latestPulse.subject}${otherCount > 0 ? `. ${otherCount} more signals.` : '.'}`
    : 'No signals yet.';

  const highlights = highlightPulses.map(p => ({
    id: p.id,
    signalType: p.signalType,
    from: { type: p.fromType, name: p.fromId },
    subject: p.subject,
    linkedTaskId: p.linkedTaskId ?? undefined,
    createdAt: p.createdAt,
  }));

  updateCursor(missionId, readerType, readerId);

  return {
    summary,
    newSinceLastCheck,
    counts,
    highlights,
  };
}
