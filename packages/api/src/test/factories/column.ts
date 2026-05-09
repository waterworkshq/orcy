import type { Column } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeColumn(overrides: Partial<Column> = {}): Column {
  const id = overrides.id ?? generateId();
  return {
    id,
    boardId: 'board-1',
    name: 'Test Column',
    order: 0,
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: false,
    nextColumnId: null,
    isTerminal: false,
    ...overrides,
  } as Column;
}
