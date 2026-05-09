import type { Feature, FeatureStatus, TaskPriority } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeFeature(overrides: Partial<Feature> = {}): Feature {
  const id = overrides.id ?? generateId();
  const now = new Date().toISOString();
  return {
    id,
    boardId: 'board-1',
    columnId: 'col-1',
    title: 'Test Feature',
    description: 'A test feature description',
    acceptanceCriteria: '',
    priority: 'medium' as TaskPriority,
    labels: [],
    status: 'not_started' as FeatureStatus,
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
  } as Feature;
}
