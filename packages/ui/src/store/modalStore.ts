import { create } from "zustand";

interface CloseRequest {
  seq: number;
  resolve: (accepted: boolean) => void;
}

/** A guarded switch intent: openModal was called while a dirty draft was
 * presented. The store retains the presented selection until the user
 * acknowledges the switch (Keep editing / Discard). */
interface SwitchIntent {
  seq: number;
  taskId: string;
}

/** Draft liveness registered by the metadata editor. The store never holds
 * the draft itself — only whether one blocks closes/switches and whether a
 * save is in flight (gates openModal synchronously). */
export interface DraftStatus {
  dirty: boolean;
  saving: boolean;
}

interface ModalStore {
  isOpen: boolean;
  selectedTaskId: string | null;
  requestSeq: number;
  pending: CloseRequest | null;
  switchIntent: SwitchIntent | null;
  draftStatus: DraftStatus | null;
  openModal: (taskId: string) => void;
  closeModal: () => void;
  requestClose: () => Promise<boolean>;
  resolveRequest: (seq: number, accepted: boolean) => void;
  acknowledgeSwitch: (seq: number, accepted: boolean) => void;
  setDraftStatus: (status: DraftStatus | null) => void;
}

const initialState = {
  isOpen: false,
  selectedTaskId: null,
  requestSeq: 0,
  pending: null,
  switchIntent: null,
  draftStatus: null,
} as const;

export const useModalStore = create<ModalStore>((set, get) => ({
  ...initialState,
  // Synchronous numbering: a same-ID reopen is distinguishable even under React
  // batching. While a save is in flight the switch intent is rejected outright —
  // selection and generation must not change under an unsettled save (no queue,
  // no replay; the caller may retry after settlement). A dirty draft may switch,
  // but the presented selection is retained until the user acknowledges it.
  openModal: (taskId) => {
    const s = get();
    if (s.draftStatus?.saving) return;
    s.pending?.resolve(false);
    if (s.isOpen && s.draftStatus?.dirty) {
      set({ requestSeq: s.requestSeq + 1, pending: null, switchIntent: { seq: s.requestSeq + 1, taskId } });
      return;
    }
    set({
      isOpen: true,
      selectedTaskId: taskId,
      requestSeq: s.requestSeq + 1,
      pending: null,
      switchIntent: null,
    });
  },
  // Forced reset only — the SessionStateProvider retirement path. Rejects any
  // pending request and drops any switch intent; the generation advances so
  // stale timers and save continuations cannot touch a later presentation.
  closeModal: () => {
    const s = get();
    s.pending?.resolve(false);
    set({ ...initialState, requestSeq: s.requestSeq + 1 });
  },
  // Ordinary close: acknowledged. true only when accepted (or nothing is open).
  // A save in flight settles false immediately — never deferred, never replayed.
  // A superseded request settles false the moment a newer request replaces it.
  requestClose: () =>
    new Promise<boolean>((resolve) => {
      const s = get();
      if (!s.isOpen) {
        resolve(true);
        return;
      }
      if (s.draftStatus?.saving) {
        resolve(false);
        return;
      }
      if (!s.draftStatus?.dirty) {
        set({
          isOpen: false,
          selectedTaskId: null,
          requestSeq: s.requestSeq + 1,
          pending: null,
          switchIntent: null,
        });
        resolve(true);
        return;
      }
      s.pending?.resolve(false);
      const seq = s.requestSeq + 1;
      set({ requestSeq: seq, pending: { seq, resolve } });
    }),
  resolveRequest: (seq, accepted) => {
    const s = get();
    if (!s.pending || s.pending.seq !== seq) return; // superseded
    s.pending.resolve(accepted);
    set(
      accepted
        ? { isOpen: false, selectedTaskId: null, pending: null, switchIntent: null }
        : { pending: null },
    );
  },
  acknowledgeSwitch: (seq, accepted) => {
    const s = get();
    if (!s.switchIntent || s.switchIntent.seq !== seq) return; // stale confirmation
    if (accepted) {
      set({
        isOpen: true,
        selectedTaskId: s.switchIntent.taskId,
        requestSeq: s.requestSeq + 1,
        pending: null,
        switchIntent: null,
      });
    } else {
      set({ requestSeq: s.requestSeq + 1, switchIntent: null });
    }
  },
  setDraftStatus: (status) => {
    const s = get();
    if (status?.saving) {
      // A save starting settles any pending close request false immediately.
      s.pending?.resolve(false);
      set({ draftStatus: status, pending: null });
      return;
    }
    set({ draftStatus: status });
  },
}));
