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
  it('routes register to boardRegisterAgent', () => {
    expect(AGENT_ACTIONS['register']).toBe(agent.boardRegisterAgent);
  });

  it('routes list to boardListAgents', () => {
    expect(AGENT_ACTIONS['list']).toBe(agent.boardListAgents);
  });

  it('routes heartbeat to boardHeartbeat', () => {
    expect(AGENT_ACTIONS['heartbeat']).toBe(agent.boardHeartbeat);
  });

  it('routes get-stats to boardGetMyStats', () => {
    expect(AGENT_ACTIONS['get-stats']).toBe(agent.boardGetMyStats);
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
