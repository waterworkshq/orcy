import { describe, it, expect, vi, beforeEach } from 'vitest';

let _filters: Record<string, { id: string; boardId: string; userId: string; name: string; filterConfig: Record<string, unknown>; isBuiltin: boolean; createdAt: string }> = {};

function createMockDb() {
  const doInsert = () => {
    let _vals: any;
    const chain = {
      values: (vals: any) => { _vals = vals; return chain; },
      run: () => {
        _filters[_vals.id] = {
          id: _vals.id,
          boardId: _vals.boardId,
          userId: _vals.userId,
          name: _vals.name,
          filterConfig: _vals.filterConfig,
          isBuiltin: _vals.isBuiltin ?? false,
          createdAt: _vals.createdAt,
        };
      },
    };
    return chain;
  };

  const doSelect = () => {
    let _condition: any;
    let _isOrderBy = false;
    const chain = {
      from: () => chain,
      where: (condition: any) => { _condition = condition; return chain; },
      orderBy: (...args: any[]) => { _isOrderBy = true; return chain; },
      all: () => {
        if (_condition?._type === 'savedFilters_list') {
          return Object.values(_filters).filter(
            f => f.boardId === _condition._boardId && (f.userId === _condition._userId || f.isBuiltin)
          ).sort((a, b) => {
            if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
            return a.createdAt.localeCompare(b.createdAt);
          });
        }
        return Object.values(_filters);
      },
    };
    return chain;
  };

  const doUpdate = () => {
    let _vals: any;
    let _condition: any;
    const chain = {
      set: (vals: any) => { _vals = vals; return chain; },
      where: (condition: any) => { _condition = condition; return chain; },
      run: () => {
        const id = _condition?.val;
        if (id && _filters[id]) {
          if (_vals.name !== undefined) _filters[id].name = _vals.name;
          if (_vals.filterConfig !== undefined) _filters[id].filterConfig = _vals.filterConfig;
        }
      },
    };
    return chain;
  };

  const doDelete = () => {
    let _condition: any;
    const chain = {
      where: (condition: any) => { _condition = condition; return chain; },
      run: () => {
        const col = _condition?.col;
        const val = _condition?.val;
        if (col === 'id' && val) {
          delete _filters[val];
        } else if (col === 'boardId' && val) {
          Object.keys(_filters).forEach(k => {
            if (_filters[k].boardId === val) delete _filters[k];
          });
        }
      },
    };
    return chain;
  };

  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
    delete: () => doDelete(),
  };
}

vi.mock('../db/index.js', () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: any) => ({ _type: `eq_${col}`, _val: val, col, val }),
  and: (...conditions: any[]) => ({ _type: 'and', conditions }),
  or: (...conditions: any[]) => ({ _type: 'or', conditions }),
  sql: (strings: any, ...values: any[]) => {
    const sqlStr = strings.join('?');
    if (sqlStr.includes('boardId') && sqlStr.includes('userId')) {
      return { _type: 'savedFilters_list', _boardId: values[0], _userId: values[1] };
    }
    return { _type: 'sql', strings, values };
  },
}));

vi.mock('../db/schema/index.js', () => ({
  savedFilters: {
    id: 'id',
    boardId: 'boardId',
    userId: 'userId',
    name: 'name',
    filterConfig: 'filterConfig',
    isBuiltin: 'isBuiltin',
    createdAt: 'createdAt',
  },
}));

describe('SavedFilter types', () => {
  it('SavedFilter interface has correct shape', async () => {
    type T = import('../repositories/savedFilter.js').SavedFilter;
    const filter: T = {
      id: 'sf-1',
      boardId: 'board-1',
      userId: 'user-1',
      name: 'My View',
      filterConfig: { priority: 'high' },
      isBuiltin: false,
      createdAt: '2026-04-11T00:00:00Z',
    };
    expect(filter.id).toBe('sf-1');
    expect(filter.name).toBe('My View');
    expect(filter.isBuiltin).toBe(false);
    expect(filter.filterConfig).toEqual({ priority: 'high' });
  });
});

describe('savedFilter repository', () => {
  beforeEach(() => {
    _filters = {};
    vi.clearAllMocks();
  });

  it('createSavedFilter creates a filter and returns it', async () => {
    const { createSavedFilter, getSavedFilterById } = await import('../repositories/savedFilter.js');
    const filter = createSavedFilter('board-1', 'user-1', 'My Tasks', { assignedAgentId: 'user-1' });
    expect(filter).toBeDefined();
    expect(filter.name).toBe('My Tasks');
    expect(filter.boardId).toBe('board-1');
    expect(filter.userId).toBe('user-1');
    expect(filter.isBuiltin).toBe(false);

    const found = getSavedFilterById(filter.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('My Tasks');
  });

  it('getSavedFilters returns user filters and built-in filters', async () => {
    const { createSavedFilter, seedBuiltinFilters, getSavedFilters } = await import('../repositories/savedFilter.js');
    seedBuiltinFilters('board-2');
    createSavedFilter('board-2', 'user-2', 'Custom View', { priority: 'high' });

    const filters = getSavedFilters('board-2', 'user-2');
    expect(filters.length).toBeGreaterThanOrEqual(3);
    const builtinCount = filters.filter(f => f.isBuiltin).length;
    expect(builtinCount).toBeGreaterThanOrEqual(2);
    const userCount = filters.filter(f => !f.isBuiltin).length;
    expect(userCount).toBe(1);
  });

  it('updateSavedFilter updates name and config', async () => {
    const { createSavedFilter, updateSavedFilter } = await import('../repositories/savedFilter.js');
    const filter = createSavedFilter('board-3', 'user-3', 'Old Name', { priority: 'low' });
    const updated = updateSavedFilter(filter.id, 'New Name', { priority: 'critical' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.filterConfig).toEqual({ priority: 'critical' });
  });

  it('updateSavedFilter returns null for non-existent filter', async () => {
    const { updateSavedFilter } = await import('../repositories/savedFilter.js');
    const result = updateSavedFilter('nonexistent', 'Name', {});
    expect(result).toBeNull();
  });

  it('deleteSavedFilter removes a filter', async () => {
    const { createSavedFilter, deleteSavedFilter, getSavedFilterById } = await import('../repositories/savedFilter.js');
    const filter = createSavedFilter('board-4', 'user-4', 'ToDelete', {});
    expect(getSavedFilterById(filter.id)).toBeDefined();

    const result = deleteSavedFilter(filter.id);
    expect(result).toBe(true);
    expect(getSavedFilterById(filter.id)).toBeNull();
  });

  it('deleteSavedFilter returns false for non-existent filter', async () => {
    const { deleteSavedFilter } = await import('../repositories/savedFilter.js');
    const result = deleteSavedFilter('nonexistent');
    expect(result).toBe(false);
  });

  it('seedBuiltinFilters creates built-in views', async () => {
    const { seedBuiltinFilters, getSavedFilters } = await import('../repositories/savedFilter.js');
    seedBuiltinFilters('board-5');
    const filters = getSavedFilters('board-5', 'any-user');
    const builtins = filters.filter(f => f.isBuiltin);
    expect(builtins.length).toBeGreaterThanOrEqual(2);
    const names = builtins.map(f => f.name);
    expect(names).toContain('High Priority');
    expect(names).toContain('Blocked');
    builtins.forEach(b => {
      expect(b.userId).toBe('system');
    });
  });

  it('deleteSavedFiltersByBoard removes all filters for a board', async () => {
    const { createSavedFilter, seedBuiltinFilters, deleteSavedFiltersByBoard, getSavedFilters } = await import('../repositories/savedFilter.js');
    createSavedFilter('board-6', 'user-6', 'View A', {});
    seedBuiltinFilters('board-6');
    expect(getSavedFilters('board-6', 'user-6').length).toBeGreaterThanOrEqual(3);
    deleteSavedFiltersByBoard('board-6');
    expect(getSavedFilters('board-6', 'user-6').length).toBe(0);
  });
});
