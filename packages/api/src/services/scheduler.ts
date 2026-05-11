import type { FastifyInstance } from 'fastify';
import { releaseStaleTasks } from './agentService.js';
import { startRetryProcessor as startTaskRetryProcessor } from './retryService.js';
import { startPresenceCleanup } from '../sse/presence.js';
import { scanAllBoards } from './anomalyService.js';
import { archiveAllBoards, archiveOldEvents } from './auditArchivalService.js';
import { getDb } from '../db/index.js';
import { tasks, features } from '../db/schema/index.js';
import { and, or, sql, notInArray, eq } from 'drizzle-orm';
import { nowExpr } from '../db/dialect-helpers.js';
import { sseBroadcaster } from '../sse/broadcaster.js';

export function startAllSchedulers(fastify: FastifyInstance): { stop: () => void } {
  const intervals: NodeJS.Timeout[] = [];

  intervals.push(setInterval(() => {
    try {
      releaseStaleTasks(30);
    } catch (err) {
      fastify.log.error({ err }, 'Error releasing stale tasks');
    }
  }, 60_000));

  intervals.push(startPresenceCleanup(60_000));

  intervals.push(setInterval(() => {
    try {
      const db = getDb();
      const nowSql = nowExpr();
      const overdueRows = db.select({ id: tasks.id, boardId: features.boardId })
        .from(tasks)
        .innerJoin(features, eq(tasks.featureId, features.id))
        .where(
          and(
            notInArray(tasks.status, ['done', 'approved', 'failed']),
            or(sql`${features.dueAt} < ${nowSql}`, sql`${features.slaDeadlineAt} < ${nowSql}`)
          )
        )
        .all();
      if (overdueRows.length > 0) {
        const now = new Date().toISOString();
        for (const row of overdueRows) {
          sseBroadcaster.publish(row.boardId, {
            type: 'task.overdue',
            data: { taskId: row.id, boardId: row.boardId, detectedAt: now },
          });
        }
      }
    } catch (err) {
      fastify.log.error({ err }, 'Error checking overdue tasks');
    }
  }, 60_000));

  intervals.push(startTaskRetryProcessor(30_000));

  intervals.push(setInterval(() => {
    try {
      scanAllBoards();
    } catch (err) {
      fastify.log.error({ err }, 'Error scanning for anomalies');
    }
  }, 5 * 60_000));

  intervals.push(setInterval(() => {
    try {
      const results = archiveAllBoards();
      if (results.length > 0) {
        fastify.log.info({ results }, 'Audit archival completed');
      }
    } catch (err) {
      fastify.log.error({ err }, 'Error archiving old events');
    }
  }, 24 * 60 * 60_000));

  return {
    stop() {
      for (const handle of intervals) {
        clearInterval(handle);
      }
    },
  };
}
