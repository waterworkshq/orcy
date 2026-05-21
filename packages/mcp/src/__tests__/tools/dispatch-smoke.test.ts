import { describe, it, expect } from 'vitest';
import {
  HABITAT_DISPATCH_HANDLER,
  MISSION_DISPATCH_HANDLER,
  TASK_DISPATCH_HANDLER,
  AGENT_DISPATCH_HANDLER,
  ADMIN_DISPATCH_HANDLER,
  SUGGEST_DISPATCH_HANDLER,
  WORKTREE_DISPATCH_HANDLER,
  MESSAGE_DISPATCH_HANDLER,
  SUBSCRIPTION_DISPATCH_HANDLER,
} from '../../tools/index.js';
import {
  HABITAT_ACTIONS,
} from '../../tools/habitat-dispatch.js';
import {
  MISSION_ACTIONS,
} from '../../tools/mission-dispatch.js';
import {
  TASK_ACTIONS,
} from '../../tools/task-dispatch.js';
import {
  AGENT_ACTIONS,
} from '../../tools/agent-dispatch.js';
import {
  ADMIN_ACTIONS,
} from '../../tools/admin-dispatch.js';
import {
  SUGGEST_ACTIONS,
} from '../../tools/suggest-dispatch.js';
import {
  WORKTREE_ACTIONS,
} from '../../tools/worktree-dispatch.js';
import {
  MESSAGE_ACTIONS,
} from '../../tools/message-dispatch.js';
import {
  SUBSCRIPTION_ACTIONS,
} from '../../tools/subscription-dispatch.js';

describe('dispatch action routing - every action maps to a function', () => {
  describe('HABITAT_ACTIONS', () => {
    for (const [action, handler] of Object.entries(HABITAT_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('MISSION_ACTIONS', () => {
    for (const [action, handler] of Object.entries(MISSION_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('TASK_ACTIONS', () => {
    for (const [action, handler] of Object.entries(TASK_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('AGENT_ACTIONS', () => {
    for (const [action, handler] of Object.entries(AGENT_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('ADMIN_ACTIONS', () => {
    for (const [action, handler] of Object.entries(ADMIN_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('SUGGEST_ACTIONS', () => {
    for (const [action, handler] of Object.entries(SUGGEST_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('WORKTREE_ACTIONS', () => {
    for (const [action, handler] of Object.entries(WORKTREE_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('MESSAGE_ACTIONS', () => {
    for (const [action, handler] of Object.entries(MESSAGE_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });

  describe('SUBSCRIPTION_ACTIONS', () => {
    for (const [action, handler] of Object.entries(SUBSCRIPTION_ACTIONS)) {
      it(`maps action "${action}" to a function`, () => {
        expect(typeof handler).toBe('function');
      });
    }
  });
});

describe('dispatch action routing - unknown action produces error', () => {
  const dispatchHandlers = [
    { name: 'HABITAT_DISPATCH_HANDLER', handler: HABITAT_DISPATCH_HANDLER },
    { name: 'MISSION_DISPATCH_HANDLER', handler: MISSION_DISPATCH_HANDLER },
    { name: 'TASK_DISPATCH_HANDLER', handler: TASK_DISPATCH_HANDLER },
    { name: 'AGENT_DISPATCH_HANDLER', handler: AGENT_DISPATCH_HANDLER },
    { name: 'ADMIN_DISPATCH_HANDLER', handler: ADMIN_DISPATCH_HANDLER },
    { name: 'SUGGEST_DISPATCH_HANDLER', handler: SUGGEST_DISPATCH_HANDLER },
    { name: 'WORKTREE_DISPATCH_HANDLER', handler: WORKTREE_DISPATCH_HANDLER },
    { name: 'MESSAGE_DISPATCH_HANDLER', handler: MESSAGE_DISPATCH_HANDLER },
    { name: 'SUBSCRIPTION_DISPATCH_HANDLER', handler: SUBSCRIPTION_DISPATCH_HANDLER },
  ];

  for (const { name, handler } of dispatchHandlers) {
    it(`${name} returns isError for unknown action`, async () => {
      const client = {} as any;
      const result = await handler(client, { action: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown action: nonexistent');
    });
  }
});

describe('dispatch action routing - null/undefined action', () => {
  const dispatchHandlers = [
    { name: 'HABITAT_DISPATCH_HANDLER', handler: HABITAT_DISPATCH_HANDLER },
    { name: 'TASK_DISPATCH_HANDLER', handler: TASK_DISPATCH_HANDLER },
  ];

  for (const { name, handler } of dispatchHandlers) {
    it(`${name} returns isError for missing action`, async () => {
      const client = {} as any;
      const result = await handler(client, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown action: undefined');
    });
  }
});
