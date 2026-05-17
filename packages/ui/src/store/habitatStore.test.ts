import { beforeEach, describe, expect, it } from 'vitest';
import { useHabitatStore } from './habitatStore.js';
import type { Mission, Notification } from '../types/index.js';

const makeTask = (id: string, missionId: string) => ({
  id,
  missionId,
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

const makeFeature = (id: string, columnId: string): Mission => ({
  id,
  habitatId: 'habitat-1',
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

const paginationFor = (features: Mission[] = []) => ({
  features: features as any,
  total: features.length,
  offset: 0,
  isLoadingMore: false,
});

describe('habitat store mission selection', () => {
  beforeEach(() => {
    useHabitatStore.setState({
      isBulkSelectMode: false,
      selectedMissionIds: [],
      tasks: [makeTask('task-1', 'feat-1'), makeTask('task-2', 'feat-1')],
    });
  });

  it('toggleMissionSelection adds and removes ids', () => {
    const { toggleMissionSelection } = useHabitatStore.getState();

    toggleMissionSelection('feat-1');
    expect(useHabitatStore.getState().selectedMissionIds).toEqual(['feat-1']);

    toggleMissionSelection('feat-2');
    expect(useHabitatStore.getState().selectedMissionIds).toEqual(['feat-1', 'feat-2']);

    toggleMissionSelection('feat-1');
    expect(useHabitatStore.getState().selectedMissionIds).toEqual(['feat-2']);
  });

  it('setBulkSelectMode(false) clears selection', () => {
    const { toggleMissionSelection, setBulkSelectMode } = useHabitatStore.getState();

    toggleMissionSelection('feat-1');
    toggleMissionSelection('feat-2');
    expect(useHabitatStore.getState().selectedMissionIds).toHaveLength(2);

    setBulkSelectMode(false);
    expect(useHabitatStore.getState().selectedMissionIds).toEqual([]);
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(false);
  });

  it('removeTask removes task from list', () => {
    const { removeTask } = useHabitatStore.getState();

    removeTask('task-1');
    expect(useHabitatStore.getState().tasks).toHaveLength(1);
    expect(useHabitatStore.getState().tasks[0].id).toBe('task-2');
  });

  it('handleSSEEvent task.deleted removes task from list', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'task.deleted', data: { taskId: 'task-1' } });

    const state = useHabitatStore.getState();
    expect(state.tasks.find((t) => t.id === 'task-1')).toBeUndefined();
  });
});

describe('habitat store SSE mission.created', () => {
  beforeEach(() => {
    useHabitatStore.setState({ features: [], tasks: [] });
  });

  it('adds feature with default progress when progress is absent from SSE data', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.created', data: makeFeature('feat-new', 'col-1') });
 
     const state = useHabitatStore.getState();
     expect(state.features).toHaveLength(1);
     const added = state.features[0];
     expect(added.id).toBe('feat-new');
     expect(added.progress).toEqual({
       total: 0, pending: 0, claimed: 0, inProgress: 0,
       submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0,
     });
   });
 
   it('does not duplicate an already-existing feature', () => {
     const { handleSSEEvent } = useHabitatStore.getState();
 
     handleSSEEvent({ type: 'mission.created', data: makeFeature('feat-dup', 'col-1') });
     handleSSEEvent({ type: 'mission.created', data: makeFeature('feat-dup', 'col-1') });
 
     expect(useHabitatStore.getState().features).toHaveLength(1);
   });
 
   it('only invalidates target column on mission.created', () => {
    useHabitatStore.setState({
      features: [],
      columnPagination: {
        'col-1': paginationFor(),
        'col-2': paginationFor(),
      },
    });
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.created', data: makeFeature('feat-new', 'col-1') });
 
     const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
  });
});

describe('habitat store SSE targeted column invalidation', () => {
  beforeEach(() => {
    useHabitatStore.setState({
      features: [makeFeature('feat-1', 'col-1') as any],
      tasks: [],
      columnPagination: {
        'col-1': paginationFor([makeFeature('feat-1', 'col-1')]),
        'col-2': paginationFor(),
      },
    });
  });

  it('only invalidates affected column on mission.updated', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.updated', data: { ...makeFeature('feat-1', 'col-1'), title: 'Updated' } });
 
     const pag = useHabitatStore.getState().columnPagination;
     expect(pag['col-1']).toBeUndefined();
     expect(pag['col-2']).toEqual(paginationFor());
   });
 
   it('preserves progress when handling mission.updated', () => {
    const progress = { total: 5, pending: 1, claimed: 0, inProgress: 2, submitted: 0, approved: 0, done: 2, failed: 0, rejected: 0, percentage: 0 };
    useHabitatStore.setState({
      features: [{ ...makeFeature('feat-1', 'col-1'), progress } as any],
      tasks: [],
      columnPagination: { 'col-1': paginationFor(), 'col-2': paginationFor() },
    });
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.updated', data: { ...makeFeature('feat-1', 'col-1'), title: 'Updated' } });
 
     const updated = useHabitatStore.getState().features.find((f) => f.id === 'feat-1') as any;
    expect(updated.title).toBe('Updated');
    expect(updated.progress).toEqual(progress);
  });

  it('invalidates both source and destination columns on mission.moved', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.moved', data: { missionId: 'feat-1', fromColumnId: 'col-1', toColumnId: 'col-2' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toBeUndefined();
    expect(useHabitatStore.getState().features[0].columnId).toBe('col-2');
  });

  it('only invalidates affected column on mission.status_changed', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.status_changed', data: { missionId: 'feat-1', fromStatus: 'not_started', toStatus: 'in_progress' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
    expect(useHabitatStore.getState().features[0].status).toBe('in_progress');
  });

  it('only invalidates affected column on mission.deleted', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.deleted', data: { missionId: 'feat-1' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
    expect(useHabitatStore.getState().features).toHaveLength(0);
  });

  it('only invalidates affected column on mission.progress', () => {
    useHabitatStore.setState({
      features: [{ ...makeFeature('feat-1', 'col-1'), progress: { total: 0, pending: 0, claimed: 0, inProgress: 0, submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0 } } as any],
      columnPagination: {
        'col-1': paginationFor(),
        'col-2': paginationFor(),
      },
    });
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.progress', data: { missionId: 'feat-1', completed: 3, total: 5 } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toEqual(paginationFor());
  });

  it('mission.progress updates progress fields and preserves existing fields in single set', () => {
    useHabitatStore.setState({
      features: [{
        ...makeFeature('feat-1', 'col-1'),
        progress: { total: 4, pending: 1, claimed: 1, inProgress: 0, submitted: 0, approved: 0, done: 2, failed: 0, rejected: 0, percentage: 0 },
      } as any],
      columnPagination: {
        'col-1': paginationFor(),
      },
    });
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.progress', data: { missionId: 'feat-1', completed: 3, total: 5 } });

    const feat = useHabitatStore.getState().features.find((f) => f.id === 'feat-1') as any;
    expect(feat.progress.done).toBe(3);
    expect(feat.progress.total).toBe(5);
    expect(feat.progress.percentage).toBe(60);
    expect(feat.progress.pending).toBe(1);
    expect(feat.progress.claimed).toBe(1);
    expect(feat.progress.failed).toBe(0);
    expect(useHabitatStore.getState().columnPagination['col-1']).toBeUndefined();
  });
});

describe('habitat store SSE preserves third-column pagination', () => {
  beforeEach(() => {
    useHabitatStore.setState({
      features: [makeFeature('feat-1', 'col-1') as any],
      tasks: [],
      columnPagination: {
        'col-1': paginationFor([makeFeature('feat-1', 'col-1')]),
        'col-2': paginationFor(),
        'col-3': paginationFor([makeFeature('feat-3', 'col-3')]),
      },
    });
  });

  it('preserves col-3 pagination on mission.updated in col-1', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.updated', data: { ...makeFeature('feat-1', 'col-1'), title: 'Updated' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });

  it('preserves col-3 pagination on mission.moved from col-1 to col-2', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.moved', data: { missionId: 'feat-1', fromColumnId: 'col-1', toColumnId: 'col-2' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });

  it('preserves col-3 pagination on mission.deleted from col-1', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.deleted', data: { missionId: 'feat-1' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });

  it('preserves col-3 pagination on mission.status_changed in col-1', () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.status_changed', data: { missionId: 'feat-1', fromStatus: 'not_started', toStatus: 'done' } });

    const pag = useHabitatStore.getState().columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-3']).toEqual(paginationFor([makeFeature('feat-3', 'col-3')]));
  });
});

describe('habitat store SSE habitat state consistency after multiple events', () => {
  it('remains consistent after a sequence of SSE events', () => {
    const f1 = makeFeature('feat-1', 'col-1');
    const f2 = makeFeature('feat-2', 'col-2');
    useHabitatStore.setState({
      features: [f1, f2] as any,
      tasks: [],
      columnPagination: {
        'col-1': paginationFor([f1]),
        'col-2': paginationFor([f2]),
      },
    });

    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: 'mission.updated', data: { ...f1, title: 'Updated' } });
    handleSSEEvent({ type: 'mission.moved', data: { missionId: 'feat-2', fromColumnId: 'col-2', toColumnId: 'col-1' } });
    handleSSEEvent({ type: 'mission.status_changed', data: { missionId: 'feat-1', fromStatus: 'not_started', toStatus: 'in_progress' } });

    const state = useHabitatStore.getState();
    expect(state.features).toHaveLength(2);
    expect(state.features.find((f) => f.id === 'feat-1')!.columnId).toBe('col-1');
    expect(state.features.find((f) => f.id === 'feat-2')!.columnId).toBe('col-1');
    expect(state.features.find((f) => f.id === 'feat-1')!.status).toBe('in_progress');

    const pag = state.columnPagination;
    expect(pag['col-1']).toBeUndefined();
    expect(pag['col-2']).toBeUndefined();
  });
});

describe('habitat store notifications', () => {
  beforeEach(() => {
    useHabitatStore.setState({ notifications: [] });
  });

  it('addNotification generates unique ID and sets read=false', () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({
      type: 'task.claimed',
      taskId: 'task-1',
      taskTitle: 'Test task',
      message: 'Agent claimed task',
      timestamp: '2026-04-30T00:00:00.000Z',
    });

    const state = useHabitatStore.getState();
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
    const { addNotification } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'First', message: 'm1', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'Second', message: 'm2', timestamp: '2026-04-30T00:01:00.000Z' });

    const state = useHabitatStore.getState();
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications[0].type).toBe('b');
    expect(state.notifications[1].type).toBe('a');
  });

  it('addNotification generates unique IDs for each call', () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T1', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T2', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const [n1, n2] = useHabitatStore.getState().notifications;
    expect(n1.id).not.toBe(n2.id);
  });

  it('addNotification preserves optional agentName', () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', agentName: 'Agent-1', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const state = useHabitatStore.getState();
    expect(state.notifications[0].agentName).toBeUndefined();
    expect(state.notifications[1].agentName).toBe('Agent-1');
  });

  it('markNotificationRead sets read=true for matching ID', () => {
    const { addNotification, markNotificationRead } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const id = useHabitatStore.getState().notifications[0].id;
    markNotificationRead(id);

    expect(useHabitatStore.getState().notifications[0].read).toBe(true);
  });

  it('markNotificationRead does not affect other notifications', () => {
    const { addNotification, markNotificationRead } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T1', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T2', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    const id = useHabitatStore.getState().notifications[1].id;
    markNotificationRead(id);

    const state = useHabitatStore.getState();
    expect(state.notifications[0].read).toBe(false);
    expect(state.notifications[1].read).toBe(true);
  });

  it('clearNotifications empties the notifications array', () => {
    const { addNotification, clearNotifications } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    addNotification({ type: 'b', taskId: 't2', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });
    expect(useHabitatStore.getState().notifications).toHaveLength(2);

    clearNotifications();
    expect(useHabitatStore.getState().notifications).toEqual([]);
  });

  it('notifications persist across other state updates', () => {
    const { addNotification, setTasks } = useHabitatStore.getState();

    addNotification({ type: 'a', taskId: 't1', taskTitle: 'T', message: 'm', timestamp: '2026-04-30T00:00:00.000Z' });

    setTasks([makeTask('task-new', 'feat-1')]);

    const state = useHabitatStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
  });
});
