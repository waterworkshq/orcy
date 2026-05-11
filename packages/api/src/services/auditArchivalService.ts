import { getDb } from '../db/index.js';
import { boards, taskEvents, tasks, features } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(__dirname);
const ARCHIVES_DIR = process.env.ARCHIVES_DIR || join(workspaceRoot, 'archives');

export interface ArchiveResult {
  archivedCount: number;
  archivePath: string;
}

export function getRetentionSettings(boardId: string): { eventRetentionDays: number } {
  const db = getDb();
  const row = db.select({ eventRetentionDays: boards.eventRetentionDays })
    .from(boards)
    .where(eq(boards.id, boardId))
    .get();
  return { eventRetentionDays: row?.eventRetentionDays ?? 90 };
}

export function archiveOldEvents(boardId: string): ArchiveResult {
  const { eventRetentionDays } = getRetentionSettings(boardId);
  const db = getDb();

  const cutoff = new Date(Date.now() - eventRetentionDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.select({
    id: taskEvents.id,
    taskId: taskEvents.taskId,
    actorType: taskEvents.actorType,
    actorId: taskEvents.actorId,
    action: taskEvents.action,
    fromColumnId: taskEvents.fromColumnId,
    toColumnId: taskEvents.toColumnId,
    fromStatus: taskEvents.fromStatus,
    toStatus: taskEvents.toStatus,
    metadata: taskEvents.metadata,
    timestamp: taskEvents.timestamp,
    boardId: features.boardId,
  })
  .from(taskEvents)
  .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
  .innerJoin(features, eq(tasks.featureId, features.id))
  .where(and(eq(features.boardId, boardId), sql`${taskEvents.timestamp} < ${cutoff}`))
  .all();

  const events: Record<string, unknown>[] = rows as unknown as Record<string, unknown>[];
  const eventIds = rows.map(r => r.id);

  if (events.length === 0) {
    return { archivedCount: 0, archivePath: '' };
  }

  const boardDir = join(ARCHIVES_DIR, boardId);
  if (!existsSync(boardDir)) mkdirSync(boardDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const archivePath = join(boardDir, `${date}.json`);

  let existing: Record<string, unknown>[] = [];
  if (existsSync(archivePath)) {
    try {
      const content = readFileSync(archivePath, 'utf-8');
      existing = JSON.parse(content);
    } catch (err) {
      logger.warn({ err, archivePath }, 'Failed to read/parse existing archive file, starting fresh');
    }
  }

  const merged = [...existing, ...events];
  writeFileSync(archivePath, JSON.stringify(merged, null, 2));

  for (const id of eventIds) {
    db.delete(taskEvents).where(eq(taskEvents.id, id)).run();
  }

  return { archivedCount: events.length, archivePath };
}

export function archiveAllBoards(): ArchiveResult[] {
  const db = getDb();
  const results: ArchiveResult[] = [];
  const boardRows = db.select({ id: boards.id }).from(boards).all();
  for (const row of boardRows) {
    const result = archiveOldEvents(row.id);
    if (result.archivedCount > 0) results.push(result);
  }
  return results;
}
