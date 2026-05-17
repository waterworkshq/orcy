import { describe, it, expect } from 'vitest';
import * as suggest from '../../tools/suggest.js';
import { SUGGEST_DISPATCH_TOOL, SUGGEST_ACTIONS } from '../../tools/suggest-dispatch.js';

describe('SUGGEST_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(SUGGEST_DISPATCH_TOOL.name).toBe('orcy_suggest');
  });

  it('includes suggest-next-task action in the enum', () => {
    const actionProp = SUGGEST_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual(['suggest-next-task']);
  });

  it('requires action', () => {
    expect(SUGGEST_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('SUGGEST_ACTIONS', () => {
  it('routes suggest-next-task to habitatSuggestNextTask', () => {
    expect(SUGGEST_ACTIONS['suggest-next-task']).toBe(suggest.habitatSuggestNextTask);
  });

  it('has exactly 1 action', () => {
    expect(Object.keys(SUGGEST_ACTIONS)).toHaveLength(1);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(SUGGEST_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });
});
