import { create } from 'zustand';

interface ModalState {
  isOpen: boolean;
  selectedTaskId: string | null;
}

interface ModalActions {
  openModal: (taskId: string) => void;
  closeModal: () => void;
}

type ModalStore = ModalState & ModalActions;

const initialState: ModalState = {
  isOpen: false,
  selectedTaskId: null,
};

export const useModalStore = create<ModalStore>((set) => ({
  ...initialState,

  openModal: (taskId: string) => {
    set({ isOpen: true, selectedTaskId: taskId });
  },

  closeModal: () => {
    set({ ...initialState });
  },
}));