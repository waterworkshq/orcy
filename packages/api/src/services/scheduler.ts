import type { FastifyInstance } from 'fastify';
import { releaseStaleTasks } from './agentService.js';
import { startRetryProcessor as startTaskRetryProcessor } from './retryService.js';
import { startPresenceCleanup } from '../sse/presence.js';
import { scanAllBoards } from './anomalyService.js';
import { archiveAllBoards, archiveOldEvents } from './auditArchivalService.js';
import { applyAllBoards } from './prioritizationService.js';
import { startScheduledTaskProcessor as startScheduledTaskPoller } from './scheduledTaskService.js';
import { getDb } from '../db/index.js';
import { tasks, features } from '../db/schema/index.js';
import { and, or, sql, notInArray, eq } from 'drizzle-orm';
import { nowExpr } from '../db/dialect-helpers.js';
import { sseBroadcaster } from '../sse/broadcaster.js';

const overdueNotifiedIds = new Set<string>();

export function checkOverdueTasks(
  notifiedIds: Set<string>,
  onError: (err: unknown) => void
): number {
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

    const currentIds = new Set<string>(overdueRows.map(r => r.id));
    const now = new Date().toISOString();
    let published = 0;

    for (const row of overdueRows) {
      if (!notifiedIds.has(row.id)) {
        sseBroadcaster.publish(row.boardId, {
          type: 'task.overdue',
          data: { taskId: row.id, boardId: row.boardId, detectedAt: now },
        });
        published++;
      }
    }

    for (const id of currentIds) {
      notifiedIds.add(id);
    }
    for (const id of [...notifiedIds]) {
      if (!currentIds.has(id)) {
        notifiedIds.delete(id);
      }
    }

    return published;
  } catch (err) {
    onError(err);
    return 0;
  }
}

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
    checkOverdueTasks(overdueNotifiedIds, (err) => {
      fastify.log.error({ err }, 'Error checking overdue tasks');
    });
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

  intervals.push(setInterval(() => {
    try {
      const results = applyAllBoards();
      if (results.length > 0) {
        fastify.log.info({ count: results.length }, 'Prioritization evaluation completed');
      }
    } catch (err) {
      fastify.log.error({ err }, 'Error applying prioritization rules');
    }
  }, 5 * 60_000));

  intervals.push(startScheduledTaskPoller(60_000));

  return {
    stop() {
      for (const handle of intervals) {
        clearInterval(handle);
      }
    },
  };
}
