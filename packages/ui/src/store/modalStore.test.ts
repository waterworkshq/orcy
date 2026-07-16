import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalStore } from './modalStore.js';

describe('modalStore', () => {
  beforeEach(() => {
    useModalStore.setState({
      isOpen: false,
      selectedTaskId: null,
    });
    vi.clearAllMocks();
  });

  describe('openModal', () => {
    it('sets isOpen true and selectedTaskId', () => {
      useModalStore.getState().openModal('task-1');

      const state = useModalStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.selectedTaskId).toBe('task-1');
    });

    it('replaces the selected task id when called again', () => {
      useModalStore.getState().openModal('task-1');
      useModalStore.getState().openModal('task-2');

      const state = useModalStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.selectedTaskId).toBe('task-2');
    });
  });

  describe('closeModal', () => {
    it('resets all state to initial values', () => {
      useModalStore.getState().openModal('task-1');
      expect(useModalStore.getState().isOpen).toBe(true);

      useModalStore.getState().closeModal();

      const state = useModalStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.selectedTaskId).toBeNull();
    });
  });
});