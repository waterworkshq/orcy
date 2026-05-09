import type { Board } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeBoard(overrides: Partial<Board> = {}): Board {
  const id = overrides.id ?? generateId();
  const now = new Date().toISOString();
  return {
    id,
    name: 'Test Board',
    description: 'A test board description',
    teamId: null,
    retrySettings: null,
    anomalySettings: null,
    autoAssignSettings: null,
    codeReviewSettings: null,
    ciCdSettings: null,
    gitWorktreeSettings: null,
    eventRetentionDays: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Board;
}
