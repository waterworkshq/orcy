import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionLiveness } from "../../lib/sessionState.js";
import { useModalStore } from "../../store/modalStore.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { api } from "../../api/index.js";
import { ApiError } from "../../api/transport.js";
import type { UpdateTaskMetadataInput } from "../../api/domains/tasks.js";
import { notify } from "../../lib/toast.js";
import type { Task, TaskPriority } from "../../types/index.js";

/** The opening baseline captured when Edit mode was entered. A refetch never
 * replaces the draft and never advances this baseline. */
export interface MetadataEditOpening {
  version: number;
  identity: string;
  title: string;
  description: string;
  priority: TaskPriority;
  missionId: string;
}

interface TaskMetadataEditorProps {
  taskId: string;
  opening: MetadataEditOpening;
  /** Details query key the modal presented this Task under. On save success it
   * is patched together with the canonical key (deduplicated) so an alias
   * presentation and the canonical row stay coherent. */
  presentedKey: readonly unknown[];
  onDone: () => void;
  onCancel: () => void;
}

type SaveOutcome =
  | { kind: "version-conflict"; message: string }
  | { kind: "not-editable"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "validation"; message: string }
  | { kind: "unknown"; message: string };

const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "critical"];
const UNKNOWN_OUTCOME_MESSAGE = "Unknown outcome — refresh and compare before retrying.";

/**
 * Owns the human metadata edit draft for the live Task detail modal. The draft
 * is local and keyed to taskId + identity (the modal sets the component key):
 * refetches never replace it and never advance the opening baseline. Saves are
 * diff-only (expectedPriority only when priority is edited); the in-flight
 * latch is synchronous; structured 409 codes and transport outcomes map to
 * distinct user outcomes, with an unknown outcome gating retry behind an
 * observed fresh details read.
 */
export function TaskMetadataEditor({
  taskId,
  opening,
  presentedKey,
  onDone,
  onCancel,
}: TaskMetadataEditorProps) {
  const qc = useQueryClient();
  const isSessionActive = useSessionLiveness();
  const [title, setTitle] = useState(opening.title);
  const [description, setDescription] = useState(opening.description);
  const [priority, setPriority] = useState<TaskPriority>(opening.priority);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  /** dataUpdatedAt stamp captured when an unknown transport outcome gated the
   * retry: another attempt is allowed only after a fresh details read lands. */
  const [refreshGate, setRefreshGate] = useState(0);
  const saveLatch = useRef(false);

  const dirty = title !== opening.title || description !== opening.description || priority !== opening.priority;
  const titleValid = title.length >= 1 && title.length <= 200;
  const descriptionValid = description.length <= 5000;
  const detailsState = qc.getQueryState(presentedKey);
  const refreshReady = refreshGate > 0 && (detailsState?.dataUpdatedAt ?? 0) > refreshGate;
  const saveBlocked =
    saving ||
    !dirty ||
    !titleValid ||
    !descriptionValid ||
    outcome?.kind === "version-conflict" ||
    outcome?.kind === "not-editable" ||
    outcome?.kind === "refused" ||
    (outcome?.kind === "unknown" && !refreshReady);

  // Register draft liveness so the store can gate closes/switches without
  // holding the draft itself. The save-start registration is synchronous
  // (inside performSave) so a batched openModal cannot slip past the gate.
  useEffect(() => {
    useModalStore.getState().setDraftStatus({ dirty, saving });
  }, [dirty, saving]);
  useEffect(() => () => useModalStore.getState().setDraftStatus(null), []);

  function buildPayload(): UpdateTaskMetadataInput {
    const body: UpdateTaskMetadataInput = {
      expectedVersion: opening.version,
      expectedTaskIdentity: opening.identity,
    };
    if (title !== opening.title) body.title = title;
    if (description !== opening.description) body.description = description;
    if (priority !== opening.priority) {
      body.priority = priority;
      body.expectedPriority = opening.priority;
    }
    return body;
  }

  async function performSave() {
    if (saveLatch.current || saveBlocked) return; // synchronous in-flight latch
    saveLatch.current = true;
    const startedSeq = useModalStore.getState().requestSeq;
    useModalStore.getState().setDraftStatus({ dirty: true, saving: true });
    setSaving(true);
    setOutcome(null);
    try {
      const result = await api.tasks.updateMetadata(taskId, buildPayload());
      // Fences before the awaited cache work: the originating account must
      // still be live and the presentation generation must not have moved.
      if (!isSessionActive() || useModalStore.getState().requestSeq !== startedSeq) return;
      await qc.cancelQueries({ queryKey: queryKeys.tasks.details(taskId) });
      if (presentedKey.join() !== queryKeys.tasks.details(taskId).join()) {
        await qc.cancelQueries({ queryKey: presentedKey });
      }
      await qc.cancelQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      // ...and again after it: an awaited gap admits retirement/switch.
      if (!isSessionActive() || useModalStore.getState().requestSeq !== startedSeq) return;
      // Patch only envelopes whose nested Task ID and identity match the
      // opening baseline and whose version is strictly older; clear their edit
      // hint. Newer-version, same-version, and different-incarnation caches are
      // preserved (refreshed via invalidation instead); context is never patched.
      const patchTargets = [queryKeys.tasks.details(taskId), presentedKey];
      const seen = new Set<string>();
      for (const key of patchTargets) {
        const keyId = key.join("\u0000");
        if (seen.has(keyId)) continue;
        seen.add(keyId);
        const cached = qc.getQueryData<TaskDetailsCacheShape>(key);
        if (!cached) continue;
        if (cached.task.id !== taskId) continue;
        if (cached.metadataEditIdentity !== opening.identity) continue;
        if (!(cached.task.version < result.task.version)) continue;
        qc.setQueryData(key, {
          ...cached,
          task: result.task,
          canEditMetadata: false,
          metadataEditIdentity: undefined,
        });
      }
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
      qc.invalidateQueries({ queryKey: queryKeys.missions.tasks(opening.missionId) });
      qc.invalidateQueries({ queryKey: queryKeys.missions.details(opening.missionId) });
      qc.invalidateQueries({ queryKey: [...queryKeys.habitats.all, "tasks", result.habitatId] });
      notify.success("Task updated");
      onDone();
    } catch (error) {
      if (!isSessionActive()) return; // retired mid-save: touch nothing
      if (error instanceof ApiError) {
        const code = (error.body as { code?: string } | undefined)?.code;
        if (code === "VERSION_CONFLICT") {
          setOutcome({ kind: "version-conflict", message: error.message });
        } else if (code === "TASK_METADATA_NOT_EDITABLE") {
          setOutcome({ kind: "not-editable", message: error.message });
        } else if (error.status === 400) {
          setOutcome({ kind: "validation", message: error.message });
        } else if (error.status === 401 || error.status === 403 || error.status === 404) {
          setOutcome({ kind: "refused", message: error.message });
        } else {
          setRefreshGate(Date.now());
          setOutcome({ kind: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });
        }
      } else {
        setRefreshGate(Date.now());
        setOutcome({ kind: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });
      }
    } finally {
      saveLatch.current = false;
      if (isSessionActive()) {
        setSaving(false);
        useModalStore.getState().setDraftStatus({ dirty: true, saving: false });
      }
    }
  }

  function discardAndReload() {
    void qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
    onCancel();
  }

  return (
    <div className="flex-1 grid grid-cols-12 overflow-hidden" data-testid="metadata-editor">
      <div className="col-span-12 p-6 md:p-10">
        <CustomScrollbar className="max-h-[calc(90vh-300px)] pr-1">
          <div className="space-y-6 max-w-2xl">
            <div className="space-y-2">
              <label
                htmlFor="metadata-title"
                className="block text-xs font-label uppercase tracking-widest text-on-surface-variant"
              >
                Title
              </label>
              <input
                id="metadata-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-high/40 px-3 py-2 text-sm text-on-surface"
                maxLength={200}
              />
              {!titleValid && <p className="text-xs text-error">Title must be 1–200 characters.</p>}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="metadata-description"
                className="block text-xs font-label uppercase tracking-widest text-on-surface-variant"
              >
                Description
              </label>
              <textarea
                id="metadata-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
                maxLength={5000}
                className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-high/40 px-3 py-2 text-sm text-on-surface"
              />
              {!descriptionValid && (
                <p className="text-xs text-error">Description must be at most 5000 characters.</p>
              )}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="metadata-priority"
                className="block text-xs font-label uppercase tracking-widest text-on-surface-variant"
              >
                Priority
              </label>
              <select
                id="metadata-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full rounded-sm border border-outline-variant/30 bg-surface-container-high/40 px-3 py-2 text-sm text-on-surface"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            {outcome && (
              <div className="space-y-2 rounded-sm bg-surface-container-high/60 p-4" role="alert">
                <p className="text-sm text-on-surface">{outcome.message}</p>
                {outcome.kind === "version-conflict" && (
                  <button
                    type="button"
                    onClick={discardAndReload}
                    className="px-4 py-2 text-sm font-bold text-on-surface hover:bg-surface-variant/50 rounded-sm border border-outline-variant/20"
                  >
                    Discard and reload
                  </button>
                )}
              </div>
            )}
          </div>
        </CustomScrollbar>
      </div>

      <div className="col-span-12 p-6 md:p-8 bg-surface-container-high/50 flex items-center justify-end gap-3 border-t border-outline-variant/10">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-6 py-3 text-sm font-bold text-on-surface hover:bg-surface-variant/50 transition-all rounded-sm border border-outline-variant/20 disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void performSave()}
          disabled={saveBlocked}
          className="px-8 py-3 text-sm font-bold bg-primary-container text-on-primary-container rounded-sm shadow-[0_0_20px_rgba(62,86,97,0.4)] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}

interface TaskDetailsCacheShape {
  task: Task;
  canEditMetadata?: boolean;
  metadataEditIdentity?: string;
}

function CustomScrollbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`overflow-y-auto custom-scrollbar ${className ?? ""}`}>{children}</div>;
}
