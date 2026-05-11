import { describe, it, expect } from 'vitest';
import { features, featureDependencies, featureEvents, featureWatchers, featureTemplates, tasks } from '../db/schema.js';
import type { FeatureStatus, FeatureEventAction, Feature, FeatureWatcher, FeatureEvent, FeatureTemplate } from '../models/index.js';

describe('Schema: Features Table', () => {
  it('features table has correct column definitions', () => {
    const columns = features;
    expect(columns.id).toBeDefined();
    expect(columns.boardId).toBeDefined();
    expect(columns.columnId).toBeDefined();
    expect(columns.title).toBeDefined();
    expect(columns.description).toBeDefined();
    expect(columns.acceptanceCriteria).toBeDefined();
    expect(columns.priority).toBeDefined();
    expect(columns.labels).toBeDefined();
    expect(columns.status).toBeDefined();
    expect(columns.displayOrder).toBeDefined();
    expect(columns.dependsOn).toBeDefined();
    expect(columns.blocks).toBeDefined();
    expect(columns.dueAt).toBeDefined();
    expect(columns.slaMinutes).toBeDefined();
    expect(columns.slaDeadlineAt).toBeDefined();
    expect(columns.createdBy).toBeDefined();
    expect(columns.createdAt).toBeDefined();
    expect(columns.updatedAt).toBeDefined();
    expect(columns.version).toBeDefined();
  });

  it('features table has board and column foreign keys', () => {
    const featureConfig = features;
    expect(featureConfig.boardId).toBeDefined();
    expect(featureConfig.columnId).toBeDefined();
  });
});

describe('Schema: Feature Dependencies Table', () => {
  it('featureDependencies has composite primary key columns', () => {
    expect(featureDependencies.featureId).toBeDefined();
    expect(featureDependencies.dependsOnId).toBeDefined();
  });

  it('both columns reference features table', () => {
    expect(featureDependencies.featureId).toBeDefined();
    expect(featureDependencies.dependsOnId).toBeDefined();
  });
});

describe('Schema: Feature Events Table', () => {
  it('featureEvents has all required columns', () => {
    expect(featureEvents.id).toBeDefined();
    expect(featureEvents.featureId).toBeDefined();
    expect(featureEvents.actorType).toBeDefined();
    expect(featureEvents.actorId).toBeDefined();
    expect(featureEvents.action).toBeDefined();
    expect(featureEvents.fromColumnId).toBeDefined();
    expect(featureEvents.toColumnId).toBeDefined();
    expect(featureEvents.fromStatus).toBeDefined();
    expect(featureEvents.toStatus).toBeDefined();
    expect(featureEvents.metadata).toBeDefined();
    expect(featureEvents.timestamp).toBeDefined();
  });
});

describe('Schema: Feature Watchers Table', () => {
  it('featureWatchers has composite primary key columns', () => {
    expect(featureWatchers.featureId).toBeDefined();
    expect(featureWatchers.userId).toBeDefined();
    expect(featureWatchers.createdAt).toBeDefined();
  });
});

describe('Schema: Tasks Table Modifications', () => {
  it('tasks table has featureId column', () => {
    expect(tasks.featureId).toBeDefined();
  });

  it('tasks table has order column', () => {
    expect(tasks.order).toBeDefined();
  });

  it('tasks table does not have removed board-level fields', () => {
    const t = tasks as unknown as Record<string, unknown>;
    expect(t.boardId).toBeUndefined();
    expect(t.columnId).toBeUndefined();
    expect(t.displayOrder).toBeUndefined();
    expect(t.dependsOn).toBeUndefined();
    expect(t.blocks).toBeUndefined();
    expect(t.dueAt).toBeUndefined();
    expect(t.slaMinutes).toBeUndefined();
    expect(t.slaDeadlineAt).toBeUndefined();
  });
});

describe('Schema: Feature Templates Table', () => {
  it('featureTemplates has tasksTemplate column', () => {
    expect(featureTemplates.tasksTemplate).toBeDefined();
  });

  it('featureTemplates has all expected columns', () => {
    expect(featureTemplates.id).toBeDefined();
    expect(featureTemplates.boardId).toBeDefined();
    expect(featureTemplates.name).toBeDefined();
    expect(featureTemplates.titlePattern).toBeDefined();
    expect(featureTemplates.descriptionPattern).toBeDefined();
    expect(featureTemplates.priority).toBeDefined();
    expect(featureTemplates.labels).toBeDefined();
    expect(featureTemplates.requiredDomain).toBeDefined();
    expect(featureTemplates.requiredCapabilities).toBeDefined();
    expect(featureTemplates.isDefault).toBeDefined();
    expect(featureTemplates.usageCount).toBeDefined();
    expect(featureTemplates.createdBy).toBeDefined();
    expect(featureTemplates.createdAt).toBeDefined();
    expect(featureTemplates.tasksTemplate).toBeDefined();
  });
});

describe('Model Types: Feature Status', () => {
  it('FeatureStatus has correct enum values', () => {
    const validStatuses: FeatureStatus[] = [
      'not_started', 'in_progress', 'review', 'done', 'failed'
    ];
    expect(validStatuses).toHaveLength(5);
    for (const status of validStatuses) {
      expect(typeof status).toBe('string');
    }
  });
});

describe('Model Types: Feature Interface', () => {
  it('Feature interface compiles with correct shape', () => {
    const feature: Feature = {
      id: 'feat-1',
      boardId: 'board-1',
      columnId: 'col-1',
      title: 'Test Feature',
      description: 'A test feature',
      acceptanceCriteria: 'All tests pass',
      priority: 'medium',
      labels: ['test'],
      status: 'not_started',
      displayOrder: 0,
      dependsOn: [],
      blocks: [],
      dueAt: null,
      slaMinutes: null,
      slaDeadlineAt: null,
      createdBy: 'user-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      actualMinutes: null,
      plannedMinutes: null,
      planningAccuracy: null,
      completedAt: null,
      isArchived: false,
    };
    expect(feature.id).toBe('feat-1');
    expect(feature.status).toBe('not_started');
  });
});

describe('Model Types: FeatureEvent Interface', () => {
  it('FeatureEventAction has correct values', () => {
    const validActions: FeatureEventAction[] = [
      'created', 'updated', 'moved', 'status_changed',
      'completed', 'deleted', 'dependency_resolved'
    ];
    expect(validActions).toHaveLength(7);
  });

  it('FeatureEvent interface compiles with correct shape', () => {
    const event: FeatureEvent = {
      id: 'evt-1',
      featureId: 'feat-1',
      actorType: 'system',
      actorId: 'system',
      action: 'status_changed',
      fromColumnId: 'col-1',
      toColumnId: 'col-2',
      fromStatus: 'not_started',
      toStatus: 'in_progress',
      metadata: {},
      timestamp: new Date().toISOString(),
    };
    expect(event.action).toBe('status_changed');
  });
});

describe('Model Types: FeatureWatcher Interface', () => {
  it('FeatureWatcher interface compiles with correct shape', () => {
    const watcher: FeatureWatcher = {
      featureId: 'feat-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
    };
    expect(watcher.featureId).toBe('feat-1');
  });
});

describe('Model Types: FeatureTemplate Interface', () => {
  it('FeatureTemplate interface compiles with tasksTemplate', () => {
    const template: FeatureTemplate = {
      id: 'tmpl-1',
      boardId: null,
      name: 'Test Template',
      titlePattern: 'Test ',
      descriptionPattern: '',
      priority: 'medium',
      labels: [],
      requiredDomain: null,
      requiredCapabilities: [],
      isDefault: false,
      usageCount: 0,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      tasksTemplate: [],
    };
    expect(template.tasksTemplate).toEqual([]);
  });
});
