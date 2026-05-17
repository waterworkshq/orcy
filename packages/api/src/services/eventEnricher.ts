import { getDb } from '../db/index.js';
import { habitats } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { SSEEvent } from '../models/index.js';
import { getTaskById } from '../repositories/task.js';
import { getAgentById } from '../repositories/agent.js';
import type { EventEnrichment } from './webhook-formatters/standard.js';

function getHabitatNameById(habitatId: string): string {
  const db = getDb();
  const row = db.select({ name: habitats.name }).from(habitats).where(eq(habitats.id, habitatId)).get();
  return row?.name ?? habitatId;
}

export function enrichEvent(habitatId: string, event: SSEEvent): EventEnrichment {
  const habitatName = getHabitatNameById(habitatId);
  const enrichment: EventEnrichment = { habitatName };

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
