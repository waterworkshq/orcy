import type { KanbanApiClient } from '../api.js';
import type { Task, TaskEvent, TaskComment } from '@orcy/shared';
import type { AgentMessage } from '../types.js';

export interface EnrichedTask extends Task {
  assignedAgentName?: string | null;
}

export interface EnrichedTaskEvent extends TaskEvent {
  actorName: string;
}

export interface EnrichedComment extends TaskComment {
  authorName: string;
}

export interface EnrichedMessage extends AgentMessage {
  fromAgentName: string;
}

export async function buildAgentNameMap(
  client: KanbanApiClient,
  agentIds: string[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(agentIds.filter(Boolean))];
  const agentLookups = await Promise.all(uniqueIds.map(id => client.getAgentById(id)));
  const nameMap = new Map<string, string>();
  agentLookups.forEach((response, i) => {
    if (response?.agent) {
      nameMap.set(uniqueIds[i], response.agent.name);
    }
  });
  return nameMap;
}

export async function enrichEventsWithActorNames(
  client: KanbanApiClient,
  events: TaskEvent[]
): Promise<EnrichedTaskEvent[]> {
  const agentIds = [...new Set(
    events.filter(e => e.actorType === 'agent').map(e => e.actorId)
  )];
  const actorNameMap = await buildAgentNameMap(client, agentIds);

  return events.map(event => {
    let actorName = event.actorId;
    if (event.actorType === 'agent') {
      actorName = actorNameMap.get(event.actorId) ?? event.actorId;
    } else if (event.actorType === 'system') {
      actorName = 'System';
    } else {
      actorName = 'Human';
    }
    return { ...event, actorName };
  });
}

export async function enrichCommentsWithAuthorNames(
  client: KanbanApiClient,
  comments: TaskComment[]
): Promise<EnrichedComment[]> {
  const agentIds = [...new Set(
    comments.filter(c => c.authorType === 'agent').map(c => c.authorId)
  )];
  const authorNameMap = await buildAgentNameMap(client, agentIds);

  return comments.map(comment => {
    let authorName = comment.authorId;
    if (comment.authorType === 'agent') {
      authorName = authorNameMap.get(comment.authorId) ?? comment.authorId;
    } else {
      authorName = 'Human';
    }
    return { ...comment, authorName };
  });
}

export async function enrichMessagesWithFromAgentNames(
  client: KanbanApiClient,
  messages: AgentMessage[]
): Promise<EnrichedMessage[]> {
  const fromAgentIds = [...new Set(messages.map(m => m.fromAgentId))];
  const agentNameMap = await buildAgentNameMap(client, fromAgentIds);

  return messages.map(message => ({
    ...message,
    fromAgentName: agentNameMap.get(message.fromAgentId) ?? message.fromAgentId,
  }));
}

export async function enrichTaskWithAgentName(
  client: KanbanApiClient,
  task: Task
): Promise<EnrichedTask> {
  if (!task.assignedAgentId) {
    return { ...task, assignedAgentName: null };
  }
  const agentResponse = await client.getAgentById(task.assignedAgentId);
  return { ...task, assignedAgentName: agentResponse?.agent?.name ?? null };
}

export async function enrichTasksWithAgentNames(
  client: KanbanApiClient,
  tasks: Task[]
): Promise<EnrichedTask[]> {
  const uniqueAgentIds = [...new Set(tasks.filter(t => t.assignedAgentId).map(t => t.assignedAgentId!))];
  const agentNameMap = await buildAgentNameMap(client, uniqueAgentIds);
  return tasks.map(task => ({
    ...task,
    assignedAgentName: task.assignedAgentId ? (agentNameMap.get(task.assignedAgentId) ?? null) : null,
  }));
}
