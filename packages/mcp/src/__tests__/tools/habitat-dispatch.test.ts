import { describe, it, expect } from 'vitest';
import * as habitat from '../../tools/habitat.js';
import * as lifecycleGaps from '../../tools/lifecycle-gaps.js';
import { HABITAT_DISPATCH_TOOL, HABITAT_ACTIONS } from '../../tools/habitat-dispatch.js';

describe('HABITAT_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(HABITAT_DISPATCH_TOOL.name).toBe('orcy_habitat');
  });

  it('includes all 6 actions in the enum', () => {
    const actionProp = HABITAT_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      'list',
      'find',
      'get-settings',
      'update-settings',
      'summary',
      'metrics',
    ]);
  });

  it('requires action', () => {
    expect(HABITAT_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('HABITAT_ACTIONS', () => {
  it('routes list to habitatListHabitats', () => {
    expect(HABITAT_ACTIONS['list']).toBe(habitat.habitatListHabitats);
  });

  it('routes find to habitatFind', () => {
    expect(HABITAT_ACTIONS['find']).toBe(habitat.habitatFind);
  });

  it('routes get-settings to habitatGetSettings', () => {
    expect(HABITAT_ACTIONS['get-settings']).toBe(habitat.habitatGetSettings);
  });

  it('routes update-settings to habitatUpdateSettings', () => {
    expect(HABITAT_ACTIONS['update-settings']).toBe(habitat.habitatUpdateSettings);
  });

  it('routes summary to habitatGetSummary', () => {
    expect(HABITAT_ACTIONS['summary']).toBe(habitat.habitatGetSummary);
  });

  it('routes metrics to habitatGetMetrics', () => {
    expect(HABITAT_ACTIONS['metrics']).toBe(lifecycleGaps.habitatGetMetrics);
  });

  it('has exactly 6 actions', () => {
    expect(Object.keys(HABITAT_ACTIONS)).toHaveLength(6);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(HABITAT_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });
});
