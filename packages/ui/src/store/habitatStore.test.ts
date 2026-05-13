import { beforeEach, describe, expect, it } from 'vitest';
import { useBoardStore } from './habitatStore.js';
import type { Feature, Notification } from '../types/index.js';

const makeTask = (id: string, featureId: string) => ({
  id,
  featureId,
  title: `Task ${id}`,
  description: '',
  priority: 'medium' as const,
  assignedAgentId: null,
  delegatedToAgentId: null,
  requiredDomain: null,
  requiredCapabilities: [],
  status: 'pending' as const,
  claimedAt: null,
  startedAt: null,
  submittedAt: null,
  completedAt: null,
  rejectedCount: 0,
  rejectionReason: null,
  result: null,
  artifacts: [],
  order: 0,
  createdBy: 'user-1',
  createdAt: '2026-04-10T00:00:00.000Z',
  updatedAt: '2026-04-10T00:00:00.000Z',
  version: 1,
  estimatedMinutes: null,
  actualMinutes: null,
  cycleTimeMinutes: null,
  leadTimeMinutes: null,
  estimationAccuracy: null,
  retryPolicy: null,
  retryCount: 0,
  nextRetryAt: null,
  labels: [],
});

const makeFeature = (id: string, columnId: string): Feature => ({
  id,
  boardId: 'board-1',
  columnId,
  title: `Feature ${id}`,
  description: '',
  acceptanceCriteria: '',
  priority: 'medium',
  labels: [],
  status: 'not_started',
  displayOrder: 0,
  dependsOn: [],
  blocks: [],
  dueAt: null,
  slaMinutes: null,
  slaDeadlineAt: null,
  createdBy: 'user-1',
  createdAt: '2026-04-10T00:00:00.000Z',
  updatedAt: '2026-04-10T00:00:00.000Z',
  version: 1,
  isArchived: false,
  actualMinutes: null,
  plannedMinutes: null,
  planningAccuracy: null,
  completedAt: null,
});

const paginationFor = (features: Feature[] = []) => ({
  features: features as any,
  total: features.length,
  offset: 0,
  isLoadingMore: false,
});

describe('board store feature selection', () => {
  beforeEach(() => {
    useBoardStore.setState({
      isBulkSelectMode: false,
      selectedFeatureIds: [],
      tasks: [makeTask('task-1', 'feat-1'), makeTask('task-2', 'feat-1')],
    });
  });

  it('toggleFeatureSelection adds and removes ids', () => {
    const { toggleFeatureSelection } = useBoardStore.getState();

    toggleFeatureSelection('feat-1');
    expect(useBoardStore.getState().selectedFeatureIds).toEqual(['feat-1']);

    toggleFeatureSelection('feat-2');
    expect(useBoardStore.getState().selectedFeatureIds).toEqual(['feat-1', 'feat-2']);

    toggleFeatureSelection('feat-1');
    expect(useBoardStore.getState().selectedFeatureIds).toEqual(['feat-2']);
  });

  it('setBulkSelectMode(false) clears selection', () => {
    const { toggleFeatureSelection, setBulkSelectMode } = useBoardStore.getState();

    toggleFeatureSelection('feat-1');
    toggleFeatureSelection('feat-2');
    expect(useBoardStore.getState().selectedFeatureIds).toHaveLength(2);

    setBulkSelectMode(false);
    expect(useBoardStore.getState().selectedFeatureIds).toEqual([]);
    expect(useBoardStore.getState().isBulkSelectMode).toBe(false);
  });

  it('removeTask removes task from list', () => {
    const { removeTask } = useBoardStore.getState();

    removeTask('task-1');
    expect(useBoardStore.getState().tasks).toHaveLength(1);
    expect(useBoardStore.getState().tasks[0].id).toBe('task-2');
  });

  it('handleSSEEvent task.deleted removes task from list', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'task.deleted', data: { taskId: 'task-1' } });

    const state = useBoardStore.getState();
    expect(state.tasks.find((t) => t.id === 'task-1')).toBeUndefined();
  });
});

describe('board store SSE feature.created', () => {
  beforeEach(() => {
    useBoardStore.setState({ features: [], tasks: [] });
  });

  it('adds feature with default progress when progress is absent from SSE data', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.created', data: makeFeature('feat-new', 'col-1') });

    const state = useBoardStore.getState();
    expect(state.features).toHaveLength(1);
    const added = state.features[0];
    expect(added.id).toBe('feat-new');
    expect(added.progress).toEqual({
      total: 0, pending: 0, claimed: 0, inProgress: 0,
      submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0,
    });
  });

  it('does not duplicate an already-existing feature', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.created', data: makeFeature('feat-dup', 'col-1') });
    handleSSEEvent({ type: 'feature.created', data: makeFeature('feat-dup', 'col-1') });

    expect(useBoardStore.getState().features).toHaveLength(1);
  });

  it('only invalidates target column on feature.created', () => {
    useBoardStore.setState({
      features: [],
      columnPagination: {
        'col-1': paginationFor(),
        'col-2': paginationFor(),
      },
    });
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.created', data: makeFeature('feat-new', 'col-1') });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
  });
});

describe('board store SSE targeted column invalidation', () => {
  beforeEach(() => {
    useBoardStore.setState({
      features: [makeFeature('feat-1', 'col-1') as any],
      tasks: [],
      columnPagination: {
        'col-1': paginationFor([makeFeature('feat-1', 'col-1')]),
        'col-2': paginationFor(),
      },
    });
  });

  it('only invalidates affected column on feature.updated', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.updated', data: { ...makeFeature('feat-1', 'col-1'), title: 'Updated' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
  });

  it('preserves progress when handling feature.updated', () => {
    const progress = { total: 5, pending: 1, claimed: 0, inProgress: 2, submitted: 0, approved: 0, done: 2, failed: 0, rejected: 0, percentage: 0 };
    useBoardStore.setState({
      features: [{ ...makeFeature('feat-1', 'col-1'), progress } as any],
      tasks: [],
      columnPagination: { 'col-1': paginationFor(), 'col-2': paginationFor() },
    });
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.updated', data: { ...makeFeature('feat-1', 'col-1'), title: 'Updated' } });

    const updated = useBoardStore.getState().features.find((f) => f.id === 'feat-1') as any;
    expect(updated.title).toBe('Updated');
    expect(updated.progress).toEqual(progress);
  });

  it('invalidates both source and destination columns on feature.moved', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.moved', data: { featureId: 'feat-1', fromColumnId: 'col-1', toColumnId: 'col-2' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toBeUndefined();
    expect(useBoardStore.getState().features[0].columnId).toBe('col-2');
  });

  it('only invalidates affected column on feature.status_changed', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.status_changed', data: { featureId: 'feat-1', fromStatus: 'not_started', toStatus: 'in_progress' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
    expect(useBoardStore.getState().features[0].status).toBe('in_progress');
  });

  it('only invalidates affected column on feature.deleted', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.deleted', data: { featureId: 'feat-1' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
    expect(useBoardStore.getState().features).toHaveLength(0);
  });

  it('only invalidates affected column on feature.progress', () => {
    useBoardStore.setState({
      features: [{ ...makeFeature('feat-1', 'col-1'), progress: { total: 0, pending: 0, claimed: 0, inProgress: 0, submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0 } } as any],
      columnPagination: {
        'col-1': paginationFor(),
        'col-2': paginationFor(),
      },
    });
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.progress', data: { featureId: 'feat-1', completed: 3, total: 5 } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
  });

  it('feature.progress updates progress fields and preserves existing fields in single set', () => {
    useBoardStore.setState({
      features: [{
        ...makeFeature('feat-1', 'col-1'),
        progress: { total: 4, pending: 1, claimed: 1, inProgress: 0, submitted: 0, approved: 0, done: 2, failed: 0, rejected: 0, percentage: 0 },
      } as any],
      columnPagination: {
        'col-1': paginationFor(),
      },
    });
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.progress', data: { featureId: 'feat-1', completed: 3, total: 5 } });

    const feat = useBoardStore.getState().features.find((f) => f.id === 'feat-1') as any;
    expect(feat.progress.done).toBe(3);
    expect(feat.progress.total).toBe(5);
    expect(feat.progress.percentage).toBe(60);
    expect(feat.progress.pending).toBe(1);
    expect(feat.progress.claimed).toBe(1);
    expect(feat.progress.failed).toBe(0);
    expect(useBoardStore.getState().columnPagination['col-1']).toBeUndefined();
  });
});

describe('board store SSE preserves third-column pagination', () => {
  beforeEach(() => {
    useBoardStore.setState({
      features: [makeFeature('feat-1', 'col-1') as any],
      tasks: [],
      columnPagination: {
        'col-1': paginationFor([makeFeature('feat-1', 'col-1')]),
        'col-2': paginationFor(),
        'col-3': paginationFor([makeFeature('feat-3', 'col-3')]),
      },
    });
  });

  it('preserves col-3 pagination on feature.updated in col-1', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.updated', data: { ...makeFeature('feat-1', 'col-1'), title: 'Updated' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });

  it('preserves col-3 pagination on feature.moved from col-1 to col-2', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.moved', data: { featureId: 'feat-1', fromColumnId: 'col-1', toColumnId: 'col-2' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });

  it('preserves col-3 pagination on feature.deleted from col-1', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.deleted', data: { featureId: 'feat-1' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });

  it('preserves col-3 pagination on feature.status_changed in col-1', () => {
    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.status_changed', data: { featureId: 'feat-1', fromStatus: 'not_started', toStatus: 'done' } });

    const pag = useBoardStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });
});

describe('board store SSE board state consistency after multiple events', () => {
  it('remains consistent after a sequence of SSE events', () => {
    const f1 = makeFeature('feat-1', 'col-1');
    const f2 = makeFeature('feat-2', 'col-2');
    useBoardStore.setState({
      features: [f1, f2] as any,
      tasks: [],
      columnPagination: {
        'col-1': paginationFor([f1]),
        'col-2': paginationFor([f2]),
      },
    });

    const { handleSSEEvent } = useBoardStore.getState();

    handleSSEEvent({ type: 'feature.updated', data: { ...f1, title: 'Updated' } });
    handleSSEEvent({ type: 'feature.moved', data: { featureId: 'feat-2', fromColumnId: 'col-2', toColumnId: 'col-1' } });
    handleSSEEvent({ type: 'feature.status_changed', data: { featureId: 'feat-1', fromStatus: 'not_started', toStatus: 'in_progress' } });

    const state = useBoardStore.getState();
    expect(state.features).toHaveLength(2);
    expect(state.features.find((f) => f.id === 'feat-1')!.columnId).toBe('col-1');
    expect(state.features.find((f) => f.id === 'feat-2')!.columnId).toBe('col-1');
    expect(state.features.find((f) => f.id === 'feat-1')!.status).toBe('in_progress');

    const pag = state.columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toBeUndefined();
  });
});

describe('board store notifications', () => {
  beforeEach(() => {
    useBoardStore.setState({ notifications: [] });
  });

  it('addNotification generates unique ID and sets read=false', () => {
    const { addNotification } = useBoardStore.getState();

    addNotification({
      type: 'task.claimed',
      taskId: 'task-1',
      taskTitle: 'Test task',
      message: 'Agent claimed task',
      timestamp: '2026-04-30T00:00:00.000Z',
    });

    const state = useBoardStore.getState();
    expect(state.notifications).toHaveLength(1);
    const n = state.notifications[0];
    expect(n.id).toBeTruthy();
    expect(n.read).toBe(false);
    expect(n.type).toBe('task.claimed');
    expect(n.taskId).toBe('task-1');
    expect(n.taskTitle).toBe('Test task');
    expect(n.message).toBe('Agent claimed task');
  });

  it('addNotification prepends to notifications array (newest first)', () => {
    const { addNotification } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'First', message: 'm1', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'Second', message: 'm2', timestamp: '2026-04-30T00:01:00.000Z' });

    const state = useBoardStore.getState();
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications[0].type).toBe('b');
    expect(state.notifications[1].type).toBe('a');
  });

  it('addNotification generates unique IDs for each call', () => {
    const { addNotification } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T1', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T2', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const [n1, n2] = useBoardStore.getState().notifications;
    expect(n1.id).not.toBe(n2.id);
  });

  it('addNotification preserves optional agentName', () => {
    const { addNotification } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', agentName: 'Agent-1', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const state = useBoardStore.getState();
    expect(state.notifications[0].agentName).toBeUndefined();
    expect(state.notifications[1].agentName).toBe('Agent-1');
  });

  it('markNotificationRead sets read=true for matching ID', () => {
    const { addNotification, markNotificationRead } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const id = useBoardStore.getState().notifications[0].id;
    markNotificationRead(id);

    expect(useBoardStore.getState().notifications[0].read).toBe(true);
  });

  it('markNotificationRead does not affect other notifications', () => {
    const { addNotification, markNotificationRead } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T1', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T2', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const id = useBoardStore.getState().notifications[1].id;
    markNotificationRead(id);

    const state = useBoardStore.getState();
    expect(state.notifications[0].read).toBe(false);
    expect(state.notifications[1].read).toBe(true);
  });

  it('clearNotifications empties the notifications array', () => {
    const { addNotification, clearNotifications } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    expect(useBoardStore.getState().notifications).toHaveLength(2);

    clearNotifications();
    expect(useBoardStore.getState().notifications).toEqual([]);
  });

  it('notifications persist across other state updates', () => {
    const { addNotification, setTasks } = useBoardStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    setTasks([makeTask('task-new', 'feat-1')]);

    const state = useBoardStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
  });
});
