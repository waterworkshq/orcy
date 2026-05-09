import { describe, it, expect } from 'vitest';
import * as worktree from '../../tools/worktree.js';
import { WORKTREE_DISPATCH_TOOL, WORKTREE_ACTIONS } from '../../tools/worktree-dispatch.js';

describe('WORKTREE_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(WORKTREE_DISPATCH_TOOL.name).toBe('orcy_worktree');
  });

  it('includes get-worktree action in the enum', () => {
    const actionProp = WORKTREE_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual(['get-worktree']);
  });

  it('requires action', () => {
    expect(WORKTREE_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('WORKTREE_ACTIONS', () => {
  it('routes get-worktree to boardGetWorktree', () => {
    expect(WORKTREE_ACTIONS['get-worktree']).toBe(worktree.boardGetWorktree);
  });

  it('has exactly 1 action', () => {
    expect(Object.keys(WORKTREE_ACTIONS)).toHaveLength(1);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(WORKTREE_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });
});
