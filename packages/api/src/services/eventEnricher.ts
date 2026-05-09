import { getDb } from '../db/index.js';
import { boards } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { SSEEvent } from '../models/index.js';
import { getTaskById } from '../repositories/task.js';
import { getAgentById } from '../repositories/agent.js';
import type { EventEnrichment } from './webhook-formatters/standard.js';

function getBoardNameById(boardId: string): string {
  const db = getDb();
  const row = db.select({ name: boards.name }).from(boards).where(eq(boards.id, boardId)).get();
  return row?.name ?? boardId;
}

export function enrichEvent(boardId: string, event: SSEEvent): EventEnrichment {
  const boardName = getBoardNameById(boardId);
  const enrichment: EventEnrichment = { boardName };

  if ('taskId' in event.data) {
    const task = getTaskById(event.data.taskId as string);
    if (task) {
      let assignedAgentName: string | undefined;
      if (task.assignedAgentId) {
        const agent = getAgentById(task.assignedAgentId);
        assignedAgentName = agent?.name;
      }
      enrichment.task = {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assignedAgentId: task.assignedAgentId,
        assignedAgentName,
        result: task.result,
        artifacts: task.artifacts || [],
      };
    }
  }

  return enrichment;
}
