import { describe, it, expect } from 'vitest';
import * as taskLifecycle from '../../tools/task-lifecycle.js';
import * as taskCrud from '../../tools/task-crud.js';
import * as taskDetail from '../../tools/task-detail.js';
import * as lifecycleGaps from '../../tools/lifecycle-gaps.js';
import * as subtask from '../../tools/subtask.js';
import * as mission from '../../tools/mission.js';
import { TASK_DISPATCH_TOOL, TASK_ACTIONS } from '../../tools/task-dispatch.js';

describe('TASK_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(TASK_DISPATCH_TOOL.name).toBe('orcy_habitat_task');
  });

  it('includes all 24 actions in the enum', () => {
    const actionProp = TASK_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      'list-in-mission',
      'create-in-mission',
      'update',
      'delete',
      'claim',
      'submit',
      'complete',
      'release',
      'retry',
      'get-context',
      'get-events',
      'get-comments',
      'add-comment',
      'get-time-report',
      'get-blocked-status',
      'get-approval-status',
      'add-dependency',
      'remove-dependency',
      'get-quality-checklist',
      'update-quality-checklist-item',
      'validate-quality-gates',
      'list-subtasks',
      'create-subtask',
      'delete-subtask',
    ]);
  });

  it('requires action', () => {
    expect(TASK_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('TASK_ACTIONS', () => {
  describe('lifecycle actions', () => {
    it('routes claim to boardClaimTask', () => {
      expect(TASK_ACTIONS['claim']).toBe(taskLifecycle.boardClaimTask);
    });

    it('routes submit to boardSubmitTask', () => {
      expect(TASK_ACTIONS['submit']).toBe(taskLifecycle.boardSubmitTask);
    });

    it('routes complete to boardCompleteTask', () => {
      expect(TASK_ACTIONS['complete']).toBe(taskLifecycle.boardCompleteTask);
    });

    it('routes release to boardReleaseTask', () => {
      expect(TASK_ACTIONS['release']).toBe(taskLifecycle.boardReleaseTask);
    });

    it('routes retry to boardRetryTask', () => {
      expect(TASK_ACTIONS['retry']).toBe(taskLifecycle.boardRetryTask);
    });
  });

  describe('CRUD actions', () => {
    it('routes list-in-mission to missionListTasks', () => {
      expect(TASK_ACTIONS['list-in-mission']).toBe(mission.missionListTasks);
    });

    it('routes create-in-mission to missionCreateTask', () => {
      expect(TASK_ACTIONS['create-in-mission']).toBe(mission.missionCreateTask);
    });

    it('routes update to boardUpdateTask', () => {
      expect(TASK_ACTIONS['update']).toBe(taskCrud.boardUpdateTask);
    });

    it('routes delete to boardDeleteTask', () => {
      expect(TASK_ACTIONS['delete']).toBe(taskCrud.boardDeleteTask);
    });
  });

  describe('detail actions', () => {
    it('routes get-context to boardGetTaskContext', () => {
      expect(TASK_ACTIONS['get-context']).toBe(taskDetail.boardGetTaskContext);
    });

    it('routes get-events to boardGetTaskEvents', () => {
      expect(TASK_ACTIONS['get-events']).toBe(taskDetail.boardGetTaskEvents);
    });

    it('routes get-comments to boardGetTaskComments', () => {
      expect(TASK_ACTIONS['get-comments']).toBe(taskDetail.boardGetTaskComments);
    });

    it('routes add-comment to boardAddTaskComment', () => {
      expect(TASK_ACTIONS['add-comment']).toBe(taskDetail.boardAddTaskComment);
    });
  });

  describe('query actions', () => {
    it('routes get-time-report to boardGetTaskTimeReport', () => {
      expect(TASK_ACTIONS['get-time-report']).toBe(lifecycleGaps.boardGetTaskTimeReport);
    });

    it('routes get-blocked-status to boardGetTaskBlockedStatus', () => {
      expect(TASK_ACTIONS['get-blocked-status']).toBe(lifecycleGaps.boardGetTaskBlockedStatus);
    });

    it('routes get-approval-status to boardGetTaskApprovalStatus', () => {
      expect(TASK_ACTIONS['get-approval-status']).toBe(lifecycleGaps.boardGetTaskApprovalStatus);
    });
  });

  describe('dependency actions', () => {
    it('routes add-dependency to boardAddTaskDependency', () => {
      expect(TASK_ACTIONS['add-dependency']).toBe(lifecycleGaps.boardAddTaskDependency);
    });

    it('routes remove-dependency to boardRemoveTaskDependency', () => {
      expect(TASK_ACTIONS['remove-dependency']).toBe(lifecycleGaps.boardRemoveTaskDependency);
    });
  });

  describe('quality checklist actions', () => {
    it('routes get-quality-checklist to boardGetTaskQualityChecklist', () => {
      expect(TASK_ACTIONS['get-quality-checklist']).toBe(lifecycleGaps.boardGetTaskQualityChecklist);
    });

    it('routes update-quality-checklist-item to boardUpdateQualityChecklistItem', () => {
      expect(TASK_ACTIONS['update-quality-checklist-item']).toBe(lifecycleGaps.boardUpdateQualityChecklistItem);
    });

    it('routes validate-quality-gates to boardValidateQualityGates', () => {
      expect(TASK_ACTIONS['validate-quality-gates']).toBe(lifecycleGaps.boardValidateQualityGates);
    });
  });

  describe('subtask actions', () => {
    it('routes list-subtasks to boardListTaskSubtasks', () => {
      expect(TASK_ACTIONS['list-subtasks']).toBe(subtask.boardListTaskSubtasks);
    });

    it('routes create-subtask to boardCreateTaskSubtask', () => {
      expect(TASK_ACTIONS['create-subtask']).toBe(subtask.boardCreateTaskSubtask);
    });

    it('routes delete-subtask to boardDeleteTaskSubtask', () => {
      expect(TASK_ACTIONS['delete-subtask']).toBe(subtask.boardDeleteTaskSubtask);
    });
  });

  it('has exactly 24 actions', () => {
    expect(Object.keys(TASK_ACTIONS)).toHaveLength(24);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(TASK_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });

  it('TASK_ACTIONS record is exported and extensible', () => {
    const extendedActions = {
      ...TASK_ACTIONS,
      'new-action': () => {},
    };
    expect(extendedActions['new-action']).toBeDefined();
    expect(Object.keys(extendedActions)).toHaveLength(25);
  });
});
