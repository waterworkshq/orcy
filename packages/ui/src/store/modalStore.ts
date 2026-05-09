import { create } from 'zustand';
import type { Task } from '../types/index.js';
import { api } from '../api/index.js';

interface ModalState {
  isOpen: boolean;
  selectedTaskId: string | null;
  modalTask: Task | null;
  isLoading: boolean;
}

interface ModalActions {
  openModal: (taskId: string) => Promise<void>;
  closeModal: () => void;
  setModalTask: (task: Task) => void;
}

type ModalStore = ModalState & ModalActions;

const initialState: ModalState = {
  isOpen: false,
  selectedTaskId: null,
  modalTask: null,
  isLoading: false,
};

export const useModalStore = create<ModalStore>((set, get) => ({
  ...initialState,

  openModal: async (taskId: string) => {
    set({ isOpen: true, selectedTaskId: taskId, isLoading: true, modalTask: null });

    try {
      const { task } = await api.tasks.get(taskId);
      if (get().selectedTaskId === taskId) {
        set({ modalTask: task, isLoading: false });
      }
    } catch {
      if (get().selectedTaskId === taskId) {
        set({ isLoading: false });
      }
    }
  },

  closeModal: () => {
    set({ ...initialState });
  },

  setModalTask: (task: Task) => {
    set({ modalTask: task });
  },
}));
