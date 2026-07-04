import { useState, useEffect } from "react";
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
import { useUpdateMission, useBoard } from "../../lib/useHabitatData.js";
import type { MissionWithProgress, TaskPriority } from "../../types/index.js";

interface EditMissionFormProps {
  open: boolean;
  onClose: () => void;
  mission: MissionWithProgress;
}

/**
 * Full edit form for an existing mission (RM-13). Mirrors CreateMissionForm but
 * pre-fills from the mission and PATCHes with `version` for optimistic concurrency.
 * The PATCH route/schema/service/repo already support every field (incl. release-gate
 * and release-deadline). A 409 VERSION_CONFLICT surfaces a refresh hint.
 */
export function EditMissionForm({ open, onClose, mission }: EditMissionFormProps) {
  const [title, setTitle] = useState(mission.title);
  const [description, setDescription] = useState(mission.description);
  const [priority, setPriority] = useState<TaskPriority>(mission.priority);
  const [labels, setLabels] = useState(mission.labels.join(", "));
  const [dueAt, setDueAt] = useState(mission.dueAt ? mission.dueAt.slice(0, 16) : "");
  const [slaMinutes, setSlaMinutes] = useState(
    mission.slaMinutes ? String(mission.slaMinutes) : "",
  );
  const [releaseGateType, setReleaseGateType] = useState<"patch" | "minor" | "major" | "">(
    (mission.releaseGateType as "patch" | "minor" | "major" | undefined) ?? "",
  );
  const [releaseGateVersion, setReleaseGateVersion] = useState(mission.releaseGateVersion ?? "");
  const [releaseDeadlineType, setReleaseDeadlineType] = useState<"patch" | "minor" | "major" | "">(
    (mission.releaseDeadlineType as "patch" | "minor" | "major" | undefined) ?? "",
  );
  const [releaseDeadlineVersion, setReleaseDeadlineVersion] = useState(
    mission.releaseDeadlineVersion ?? "",
  );

  const updateMission = useUpdateMission(mission.id, mission.habitatId);
  const { data: boardData } = useBoard(mission.habitatId);
  // Feature-based habitats hide release-gate/deadline authoring (RM-6).
  const releaseMode = boardData?.board?.roadmapSettings?.mode !== "feature";

  // Re-sync local state whenever the underlying mission changes (e.g. after a refetch).
  useEffect(() => {
    if (!open) return;
    setTitle(mission.title);
    setDescription(mission.description);
    setPriority(mission.priority);
    setLabels(mission.labels.join(", "));
    setDueAt(mission.dueAt ? mission.dueAt.slice(0, 16) : "");
    setSlaMinutes(mission.slaMinutes ? String(mission.slaMinutes) : "");
    setReleaseGateType((mission.releaseGateType as "patch" | "minor" | "major" | undefined) ?? "");
    setReleaseGateVersion(mission.releaseGateVersion ?? "");
    setReleaseDeadlineType(
      (mission.releaseDeadlineType as "patch" | "minor" | "major" | undefined) ?? "",
    );
    setReleaseDeadlineVersion(mission.releaseDeadlineVersion ?? "");
  }, [open, mission]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    const labelList = labels
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

    try {
      await updateMission.mutateAsync({
        title: title.trim(),
        description: description.trim(),
        priority,
        labels: labelList,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        slaMinutes: slaMinutes ? parseInt(slaMinutes, 10) : null,
        releaseGateType: releaseGateType || null,
        releaseGateVersion: releaseGateVersion.trim() || null,
        releaseDeadlineType: releaseDeadlineType || null,
        releaseDeadlineVersion: releaseDeadlineVersion.trim() || null,
        version: mission.version,
      });
      notify.success("Mission updated");
      onClose();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("409") || msg.toLowerCase().includes("version_conflict")) {
        notify.error("This mission was edited elsewhere — refresh and try again");
      } else {
        notify.error(msg || "Failed to update mission");
      }
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit mission</DialogTitle>
          <DialogDescription>
            Update the mission's details. Release-gate and deadline changes take effect immediately.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Description</label>
            <RichTextEditor content={description} onChange={setDescription} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            <div>
              <label className="mb-1 block text-sm font-medium">Labels (comma-separated)</label>
              <input
                type="text"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Due date</label>
              <input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">SLA minutes</label>
              <input
                type="number"
                min="1"
                value={slaMinutes}
                onChange={(e) => setSlaMinutes(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
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
            </div>
          )}
        </form>

        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={updateMission.isPending}
            disabled={updateMission.isPending || !title.trim()}
            onClick={handleSubmit}
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
