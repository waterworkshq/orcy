import type { Habitat } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeHabitat(overrides: Partial<Habitat> = {}): Habitat {
  const id = overrides.id ?? generateId();
  const now = new Date().toISOString();
  return {
    id,
    name: 'Test Habitat',
    description: 'A test habitat description',
    teamId: null,
    retrySettings: null,
    anomalySettings: null,
    autoAssignSettings: null,
    codeReviewSettings: null,
    ciCdSettings: null,
    gitWorktreeSettings: null,
    prioritizationSettings: null,
    eventRetentionDays: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Habitat;
}
