import { describe, it, expect } from 'vitest';
import * as agent from '../../tools/agent.js';
import { AGENT_DISPATCH_TOOL, AGENT_ACTIONS } from '../../tools/agent-dispatch.js';

describe('AGENT_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(AGENT_DISPATCH_TOOL.name).toBe('orcy_habitat_agent');
  });

  it('includes all 4 actions in the enum', () => {
    const actionProp = AGENT_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      'register',
      'list',
      'heartbeat',
      'get-stats',
    ]);
  });

  it('requires action', () => {
    expect(AGENT_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('AGENT_ACTIONS', () => {
  it('routes register to habitatRegisterAgent', () => {
    expect(AGENT_ACTIONS['register']).toBe(agent.habitatRegisterAgent);
  });

  it('routes list to habitatListAgents', () => {
    expect(AGENT_ACTIONS['list']).toBe(agent.habitatListAgents);
  });

  it('routes heartbeat to habitatHeartbeat', () => {
    expect(AGENT_ACTIONS['heartbeat']).toBe(agent.habitatHeartbeat);
  });

  it('routes get-stats to habitatGetMyStats', () => {
    expect(AGENT_ACTIONS['get-stats']).toBe(agent.habitatGetMyStats);
  });

  it('has exactly 4 actions', () => {
    expect(Object.keys(AGENT_ACTIONS)).toHaveLength(4);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(AGENT_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });
});
