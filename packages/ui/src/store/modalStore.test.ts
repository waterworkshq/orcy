import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalStore } from './modalStore.js';
import type { Task } from '../types/index.js';

vi.mock('../api/index.js', () => ({
  api: {
    tasks: {
      get: vi.fn(),
    },
  },
}));

import { api } from '../api/index.js';

const makeTask = (id: string): Task => ({
  id,
  featureId: 'feat-1',
  title: `Task ${id}`,
  description: '',
  priority: 'medium',
  assignedAgentId: null,
  delegatedToAgentId: null,
  requiredDomain: null,
  requiredCapabilities: [],
  status: 'pending',
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
});

describe('modalStore', () => {
  beforeEach(() => {
    useModalStore.setState({
      isOpen: false,
      selectedTaskId: null,
      modalTask: null,
      isLoading: false,
    });
    vi.clearAllMocks();
  });

  describe('openModal', () => {
    it('sets isOpen true and selectedTaskId', async () => {
      const task = makeTask('task-1');
      vi.mocked(api.tasks.get).mockResolvedValue({ task, dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'Board', columns: [] } });

      await useModalStore.getState().openModal('task-1');

      const state = useModalStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.selectedTaskId).toBe('task-1');
      expect(state.modalTask).toEqual(task);
      expect(state.isLoading).toBe(false);
    });

    it('sets isLoading during fetch and clears after', async () => {
      let resolveFetch: (value: any) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      vi.mocked(api.tasks.get).mockReturnValue(fetchPromise as any);

      const openPromise = useModalStore.getState().openModal('task-42');

      expect(useModalStore.getState().isLoading).toBe(true);
      expect(useModalStore.getState().selectedTaskId).toBe('task-42');
      expect(useModalStore.getState().isOpen).toBe(true);

      resolveFetch!({ task: makeTask('task-42'), dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'B', columns: [] } });
      await openPromise;

      expect(useModalStore.getState().isLoading).toBe(false);
    });

    it('handles fetch failure gracefully', async () => {
      vi.mocked(api.tasks.get).mockRejectedValue(new Error('Network error'));

      await useModalStore.getState().openModal('task-fail');

      const state = useModalStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.selectedTaskId).toBe('task-fail');
      expect(state.modalTask).toBeNull();
      expect(state.isLoading).toBe(false);
    });

    it('ignores stale fetch result if taskId changed', async () => {
      let resolveFirst: (value: any) => void;
      const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
      vi.mocked(api.tasks.get).mockReturnValueOnce(firstPromise as any);
      vi.mocked(api.tasks.get).mockResolvedValue({ task: makeTask('task-2'), dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'B', columns: [] } });

      const firstOpen = useModalStore.getState().openModal('task-1');
      const secondOpen = useModalStore.getState().openModal('task-2');

      await secondOpen;
      resolveFirst!({ task: makeTask('task-1'), dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'B', columns: [] } });
      await firstOpen;

      const state = useModalStore.getState();
      expect(state.selectedTaskId).toBe('task-2');
      expect(state.modalTask?.id).toBe('task-2');
    });
  });

  describe('closeModal', () => {
    it('resets all state to initial values', async () => {
      vi.mocked(api.tasks.get).mockResolvedValue({ task: makeTask('task-1'), dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'B', columns: [] } });

      await useModalStore.getState().openModal('task-1');
      expect(useModalStore.getState().isOpen).toBe(true);

      useModalStore.getState().closeModal();

      const state = useModalStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.selectedTaskId).toBeNull();
      expect(state.modalTask).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });

  describe('setModalTask', () => {
    it('updates modalTask', async () => {
      const task = makeTask('task-1');
      vi.mocked(api.tasks.get).mockResolvedValue({ task, dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'B', columns: [] } });

      await useModalStore.getState().openModal('task-1');

      const updated = { ...task, title: 'Updated Title', status: 'in_progress' as const };
      useModalStore.getState().setModalTask(updated);

      expect(useModalStore.getState().modalTask?.title).toBe('Updated Title');
      expect(useModalStore.getState().modalTask?.status).toBe('in_progress');
    });

    it('handles multiple rapid open/close calls', async () => {
      vi.mocked(api.tasks.get).mockImplementation((id) =>
        Promise.resolve({ task: makeTask(id), dependencies: [], blockedBy: [], blocking: [], boardContext: { name: 'B', columns: [] } })
      );

      const p1 = useModalStore.getState().openModal('t-1');
      useModalStore.getState().closeModal();
      expect(useModalStore.getState().isOpen).toBe(false);

      const p2 = useModalStore.getState().openModal('t-2');
      useModalStore.getState().closeModal();
      expect(useModalStore.getState().isOpen).toBe(false);

      const p3 = useModalStore.getState().openModal('t-3');
      await Promise.all([p1, p2, p3]);

      expect(useModalStore.getState().selectedTaskId).toBe('t-3');
      expect(useModalStore.getState().modalTask?.id).toBe('t-3');

      useModalStore.getState().closeModal();
      expect(useModalStore.getState().isOpen).toBe(false);
      expect(useModalStore.getState().selectedTaskId).toBeNull();
    });
  });
});
