import type { TaskEvent, EventAction, ActorType, TaskStatus } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  const id = overrides.id ?? generateId();
  return {
    id,
    taskId: 'task-1',
    actorType: 'system' as ActorType,
    actorId: 'system',
    action: 'created' as EventAction,
    fromColumnId: null,
    toColumnId: null,
    fromStatus: null,
    toStatus: null,
    metadata: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  } as TaskEvent;
}
