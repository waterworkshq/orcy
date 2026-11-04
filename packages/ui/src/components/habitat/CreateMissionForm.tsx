import React, { useState, useEffect } from "react";
import {
  createMissionInputFromDraft,
  releaseAuthoringEnabled,
  titleReady,
  useMissionAuthoring,
} from "../../lib/missionAuthoring.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { RichTextEditor } from "../ui/RichTextEditor.js";
import { notify } from "../../lib/toast.js";
import { useSessionLiveness } from "../../lib/sessionState.js";
import { useTemplates, useCreateMission, useHabitat } from "../../lib/useHabitatData.js";
import type { TaskPriority } from "../../types/index.js";

interface CreateMissionFormProps {
  open: boolean;
  onClose: () => void;
  habitatId: string;
}

export function CreateMissionForm({ open, onClose, habitatId }: CreateMissionFormProps) {
  useTemplates(habitatId);
  const { data: boardData } = useHabitat(habitatId);
  const columns = boardData?.columns ?? [];
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [columnId, setColumnId] = useState("");
  const {
    draft,
    title,
    description,
    priority,
    labels,
    dueAt,
    slaMinutes,
    releaseGateType,
    releaseGateVersion,
    releaseDeadlineType,
    releaseDeadlineVersion,
    setTitle,
    setDescription,
    setPriority,
    setLabels,
    setDueAt,
    setSlaMinutes,
    setReleaseGateType,
    setReleaseGateVersion,
    setReleaseDeadlineType,
    setReleaseDeadlineVersion,
  } = useMissionAuthoring(open);
  const createMission = useCreateMission(habitatId);
  const isSessionActive = useSessionLiveness();
  // Feature-based habitats hide release-gate/deadline authoring (RM-6). Existing gates still display.
  const releaseMode = boardData ? releaseAuthoringEnabled(boardData) : false;

  useEffect(() => {
    if (open) setAcceptanceCriteria("");
  }, [open]);

  useEffect(() => {
    if (open && columns.length > 0) {
      const firstNonTerminal = columns.find((c) => !c.isTerminal);
      setColumnId(firstNonTerminal?.id ?? columns[0]?.id ?? "");
    }
  }, [open, columns]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!titleReady(draft) || !columnId) return;
    try {
      await createMission.mutateAsync(createMissionInputFromDraft(draft, columnId, acceptanceCriteria, releaseMode));
      if (!isSessionActive()) return;
      notify.success(`Mission "${title.trim()}" created`);
      onClose();
    } catch (err) {
      if (!isSessionActive()) return;
      notify.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>Create Mission</DialogTitle>
          <DialogDescription>Add a new mission to this habitat.</DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Mission title"
                required
                maxLength={200}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Description</label>
              <RichTextEditor
                content={description}
                onChange={setDescription}
                placeholder="Mission description"
                minHeight="120px"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Acceptance Criteria</label>
              <RichTextEditor
                content={acceptanceCriteria}
                onChange={setAcceptanceCriteria}
                placeholder="What defines done for this mission"
                minHeight="80px"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Column</label>
                <select
                  value={columnId}
                  onChange={(e) => setColumnId(e.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Labels</label>
              <input
                type="text"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="auth, api, bug (comma-separated)"
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Due Date</label>
                <input
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium">SLA (minutes)</label>
                <input
                  type="number"
                  min="1"
                  placeholder="e.g., 60"
                  value={slaMinutes}
                  onChange={(e) => setSlaMinutes(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            {releaseMode && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Release Gate</label>
                  <select
                    value={releaseGateType}
                    onChange={(e) =>
                      setReleaseGateType(e.target.value as "patch" | "minor" | "major" | "")
                    }
                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">No gate</option>
                    <option value="patch">Patch</option>
                    <option value="minor">Minor</option>
                    <option value="major">Major</option>
                  </select>
                </div>
                {releaseGateType && (
                  <div>
                    <label className="mb-1 block text-sm font-medium">Gate Version</label>
                    <input
                      type="text"
                      value={releaseGateVersion}
                      onChange={(e) => setReleaseGateVersion(e.target.value)}
                      placeholder="e.g. v0.25 or v0.25.0"
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                )}
              </div>
            )}

            {releaseMode && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Release Deadline</label>
                  <select
                    value={releaseDeadlineType}
                    onChange={(e) =>
                      setReleaseDeadlineType(e.target.value as "patch" | "minor" | "major" | "")
                    }
                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">No deadline</option>
                    <option value="patch">Patch</option>
                    <option value="minor">Minor</option>
                    <option value="major">Major</option>
                  </select>
                </div>
                {releaseDeadlineType && (
                  <div>
                    <label className="mb-1 block text-sm font-medium">Deadline Version</label>
                    <input
                      type="text"
                      value={releaseDeadlineVersion}
                      onChange={(e) => setReleaseDeadlineVersion(e.target.value)}
                      placeholder="e.g. v0.26 or v0.26.0"
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>

        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={createMission.isPending}
            disabled={createMission.isPending || !titleReady(draft)}
          >
            Create Mission
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
