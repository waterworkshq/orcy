import type { Mission, MissionStatus, TaskPriority } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeMission(overrides: Partial<Mission> = {}): Mission {
  const id = overrides.id ?? generateId();
  const now = new Date().toISOString();
  return {
    id,
    habitatId: 'habitat-1',
    columnId: 'col-1',
    title: 'Test Mission',
    description: 'A test mission description',
    acceptanceCriteria: '',
    priority: 'medium' as TaskPriority,
    labels: [],
    status: 'not_started' as MissionStatus,
    displayOrder: 0,
    dependsOn: [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    ...overrides,
  } as Mission;
}
