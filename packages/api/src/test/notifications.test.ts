import { describe, it, expect, vi, beforeEach } from 'vitest';

let _prefsData: Record<string, { id: string; userId: string; habitatId: string | null; taskAssigned: number; taskSubmitted: number; taskApproved: number; taskRejected: number; taskOverdue: number; taskMentioned: number; taskWatching: number; createdAt: string; updatedAt: string }> = {};
let _idCounter = 0;

function createMockDb() {
  const doInsert = () => {
    let _vals: any;
    const chain = {
      values: (vals: any) => { _vals = vals; return chain; },
      run: () => {
        const key = `${_vals.userId}:${_vals.habitatId ?? 'global'}`;
        _prefsData[key] = {
          id: _vals.id,
          userId: _vals.userId,
          habitatId: _vals.habitatId ?? null,
          taskAssigned: _vals.taskAssigned ?? 1,
          taskSubmitted: _vals.taskSubmitted ?? 1,
          taskApproved: _vals.taskApproved ?? 0,
          taskRejected: _vals.taskRejected ?? 1,
          taskOverdue: _vals.taskOverdue ?? 1,
          taskMentioned: _vals.taskMentioned ?? 1,
          taskWatching: _vals.taskWatching ?? 1,
          createdAt: _vals.createdAt,
          updatedAt: _vals.updatedAt,
        };
      },
    };
    return chain;
  };

  const doSelect = () => {
    let _conditions: any[] = [];
    const chain = {
      from: () => chain,
      where: (...args: any[]) => { _conditions = args; return chain; },
      all: () => {
        for (const cond of _conditions) {
          if (cond?._type === 'and') {
            let userId: string | undefined;
            let habitatId: string | null | undefined;
            let isNullHabitat = false;
            for (const c of cond.conditions) {
              if (c?.col === 'userId') userId = c.val;
              if (c?.col === 'habitatId') habitatId = c.val;
              if (c?._type === 'isNull_habitatId') isNullHabitat = true;
            }
            if (userId) {
              const key = isNullHabitat ? `${userId}:global` : `${userId}:${habitatId ?? 'global'}`;
              return _prefsData[key] ? [_prefsData[key]] : [];
            }
          }
        }
        return Object.values(_prefsData);
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
        if (id) {
          for (const key of Object.keys(_prefsData)) {
            if (_prefsData[key].id === id) {
              Object.assign(_prefsData[key], _vals);
              break;
            }
          }
        }
      },
    };
    return chain;
  };

  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
  };
}

vi.mock('../db/index.js', () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: any) => ({ col, val }),
  and: (...conditions: any[]) => ({ _type: 'and', conditions }),
  isNull: (col: string) => ({ _type: `isNull_${col}`, col }),
  sql: (strings: any, ...values: any[]) => ({ _type: 'sql', strings, values }),
}));

vi.mock('../db/schema/index.js', () => ({
  notificationPreferences: {
    id: 'id',
    userId: 'userId',
    habitatId: 'habitatId',
    taskAssigned: 'taskAssigned',
    taskSubmitted: 'taskSubmitted',
    taskApproved: 'taskApproved',
    taskRejected: 'taskRejected',
    taskOverdue: 'taskOverdue',
    taskMentioned: 'taskMentioned',
    taskWatching: 'taskWatching',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  users: { id: 'id', username: 'username', email: 'email' },
  tasks: { id: 'id', habitatId: 'habitatId', title: 'title', status: 'status' },
  habitats: { id: 'id', name: 'name' },
  agents: { id: 'id', name: 'name' },
  taskComments: { id: 'id' },
  taskWatchers: { taskId: 'taskId', userId: 'userId' },
  taskCommentMentions: { id: 'id' },
}));

vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++_idCounter}`,
}));

describe('notificationPreferences repository', () => {
  beforeEach(() => {
    _prefsData = {};
    _idCounter = 0;
  });

  it('creates default global preferences when none exist', async () => {
    const { getPreferences } = await import('../repositories/notificationPreferences.js');
    const prefs = getPreferences('user-1', null);
    expect(prefs.userId).toBe('user-1');
    expect(prefs.habitatId).toBeNull();
    expect(prefs.taskAssigned).toBe(true);
    expect(prefs.taskApproved).toBe(false);
    expect(prefs.taskRejected).toBe(true);
    expect(prefs.taskMentioned).toBe(true);
  });

  it('creates default habitat preferences when none exist', async () => {
    const { getPreferences } = await import('../repositories/notificationPreferences.js');
    const prefs = getPreferences('user-1', 'habitat-1');
    expect(prefs.userId).toBe('user-1');
    expect(prefs.habitatId).toBe('habitat-1');
    expect(prefs.taskAssigned).toBe(true);
  });

  it('returns existing preferences on second call', async () => {
    const { getPreferences } = await import('../repositories/notificationPreferences.js');
    const prefs1 = getPreferences('user-1', null);
    const prefs2 = getPreferences('user-1', null);
    expect(prefs1.id).toBe(prefs2.id);
  });

  it('upserts preferences', async () => {
    const { getPreferences, upsertPreferences } = await import('../repositories/notificationPreferences.js');
    getPreferences('user-1', null);
    const updated = upsertPreferences('user-1', null, { taskAssigned: false, taskApproved: true });
    expect(updated.taskAssigned).toBe(false);
    expect(updated.taskApproved).toBe(true);
    expect(updated.taskRejected).toBe(true);
  });
});

describe('emailService', () => {
  it('isConfigured returns false when SMTP is not set', async () => {
    const { isConfigured } = await import('../services/emailService.js');
    expect(isConfigured()).toBe(false);
  });

  it('sendEmail returns false when SMTP not configured', async () => {
    const { sendEmail } = await import('../services/emailService.js');
    const result = await sendEmail({ to: 'test@test.com', subject: 'Test', html: '<p>Hi</p>' });
    expect(result).toBe(false);
  });

  it('taskAssignedTemplate has correct subject', async () => {
    const { taskAssignedTemplate } = await import('../services/emailService.js');
    const payload = taskAssignedTemplate('Fix bug', 'Habitat 1', 'admin');
    expect(payload.subject).toContain('Fix bug');
    expect(payload.html).toContain('Fix bug');
    expect(payload.html).toContain('Habitat 1');
  });

  it('taskRejectedTemplate includes reason', async () => {
    const { taskRejectedTemplate } = await import('../services/emailService.js');
    const payload = taskRejectedTemplate('Fix bug', 'Habitat 1', 'admin', 'Code quality issues');
    expect(payload.html).toContain('Code quality issues');
  });

  it('commentMentionedTemplate includes comment content', async () => {
    const { commentMentionedTemplate } = await import('../services/emailService.js');
    const payload = commentMentionedTemplate('Task 1', 'Habitat 1', 'user1', 'hey @admin check this');
    expect(payload.html).toContain('hey @admin check this');
  });
});

describe('notificationService', () => {
  it('processEvent returns early when SMTP not configured', async () => {
    const { processEvent } = await import('../services/notificationService.js');
    await expect(processEvent('task.assigned', 'habitat-1', { taskId: 'task-1' })).resolves.toBeUndefined();
  });
});
