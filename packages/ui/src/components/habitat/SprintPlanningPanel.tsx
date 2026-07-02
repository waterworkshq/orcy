import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Drawer } from "../ui/Drawer.js";
import { Button } from "../ui/Button.js";
import { SprintDashboard } from "./SprintDashboard.js";
import { SprintAnalyticsPanel } from "./SprintAnalyticsPanel.js";
import { SprintBadge } from "./SprintBadge.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { useMissions } from "../../lib/useHabitatData.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { truncateId } from "../../lib/formatting.js";
import type { Sprint, MissionWithProgress } from "../../types/index.js";
import { Plus, Play, CheckCircle, XCircle, ChevronRight, ChevronDown } from "lucide-react";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";

interface SprintPlanningPanelProps {
  habitatId: string;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function SprintPlanningPanel({ habitatId, onClose }: SprintPlanningPanelProps) {
  const queryClient = useQueryClient();
  const { data: missionsData } = useMissions(habitatId);
  const features = missionsData?.features ?? [];
  const [showCreate, setShowCreate] = useState(false);
  const [expandedSprintId, setExpandedSprintId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [missionLoading, setMissionLoading] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    goal: "",
    startDate: new Date().toISOString().split("T")[0],
    endDate: new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0],
    capacityMinutes: "",
  });

  const { data: sprintsData, isLoading } = useQuery({
    queryKey: queryKeys.sprints.list(habitatId),
    queryFn: () => api.sprints.list(habitatId),
    enabled: !!habitatId,
    staleTime: 10_000,
  });

  const { data: activeData } = useQuery({
    queryKey: queryKeys.sprints.active(habitatId),
    queryFn: () => api.sprints.getActive(habitatId),
    enabled: !!habitatId,
    staleTime: 30_000,
  });

  const sprints = sprintsData?.sprints ?? [];
  const activeSprint = activeData?.sprint ?? null;
  const habitatFeatures = features;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: queryKeys.sprints.list(habitatId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sprints.active(habitatId) });
  }

  async function handleCreate() {
    if (!form.name.trim()) {
      notify.warning("Sprint name is required");
      return;
    }
    if (new Date(form.endDate) <= new Date(form.startDate)) {
      notify.warning("End date must be after start date");
      return;
    }
    setCreating(true);
    try {
      await api.sprints.create(habitatId, {
        name: form.name.trim(),
        goal: form.goal || undefined,
        startDate: form.startDate,
        endDate: form.endDate,
        capacityMinutes: form.capacityMinutes ? parseInt(form.capacityMinutes, 10) : null,
      });
      notify.success("Sprint created");
      setShowCreate(false);
      setForm({
        name: "",
        goal: "",
        startDate: form.startDate,
        endDate: form.endDate,
        capacityMinutes: "",
      });
      refresh();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleStart(sprintId: string) {
    setActing(sprintId);
    try {
      await api.sprints.start(sprintId);
      notify.success("Sprint started");
      refresh();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setActing(null);
    }
  }

  async function handleComplete(sprintId: string) {
    setActing(sprintId);
    try {
      await api.sprints.complete(sprintId);
      notify.success("Sprint completed");
      refresh();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setActing(null);
    }
  }

  async function handleCancel(sprintId: string) {
    setActing(sprintId);
    setCancelTarget(null);
    try {
      await api.sprints.cancel(sprintId);
      notify.success("Sprint cancelled");
      refresh();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setActing(null);
    }
  }

  async function handleAddMission(sprintId: string, missionId: string) {
    setMissionLoading(missionId);
    try {
      await api.sprints.addMission(sprintId, missionId);
      refresh();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setMissionLoading(null);
    }
  }

  async function handleRemoveMission(sprintId: string, missionId: string) {
    setMissionLoading(missionId);
    try {
      await api.sprints.removeMission(sprintId, missionId);
      refresh();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setMissionLoading(null);
    }
  }

  return (
    <Drawer open={true} onClose={onClose} className="w-full max-w-lg flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h2 className="text-sm font-semibold">Sprint Management</h2>
        <Button size="sm" onClick={() => setShowCreate(true)} disabled={showCreate}>
          <Plus className="h-3.5 w-3.5" /> New Sprint
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeSprint && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Active Sprint
            </p>
            <SprintCard
              sprint={activeSprint}
              expanded={expandedSprintId === activeSprint.id}
              onToggle={() =>
                setExpandedSprintId((prev) => (prev === activeSprint.id ? null : activeSprint.id))
              }
              habitatFeatures={habitatFeatures}
              acting={acting}
              missionLoading={missionLoading}
              onStart={handleStart}
              onComplete={handleComplete}
              onCancelRequest={setCancelTarget}
              onAddMission={handleAddMission}
              onRemoveMission={handleRemoveMission}
              habitatId={habitatId}
            />
          </div>
        )}

        {showCreate && (
          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm font-medium">Create Sprint</p>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="sprint-name">
                Name
              </label>
              <input
                id="sprint-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Sprint 1"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="sprint-goal">
                Goal (optional)
              </label>
              <input
                id="sprint-goal"
                type="text"
                value={form.goal}
                onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Ship auth module"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground" htmlFor="sprint-start">
                  Start Date
                </label>
                <input
                  id="sprint-start"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground" htmlFor="sprint-end">
                  End Date
                </label>
                <input
                  id="sprint-end"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-2 border-t border-border">
              <Button onClick={handleCreate} loading={creating}>
                Create
              </Button>
              <Button variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-16 rounded-lg border border-border animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              All Sprints ({sprints.length})
            </p>
            {sprints
              .filter((s) => s.id !== activeSprint?.id)
              .map((sprint) => (
                <SprintCard
                  key={sprint.id}
                  sprint={sprint}
                  expanded={expandedSprintId === sprint.id}
                  onToggle={() =>
                    setExpandedSprintId((prev) => (prev === sprint.id ? null : sprint.id))
                  }
                  habitatFeatures={habitatFeatures}
                  acting={acting}
                  missionLoading={missionLoading}
                  onStart={handleStart}
                  onComplete={handleComplete}
                  onCancelRequest={setCancelTarget}
                  onAddMission={handleAddMission}
                  onRemoveMission={handleRemoveMission}
                  habitatId={habitatId}
                />
              ))}
            {sprints.length === 0 && !showCreate && (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No sprints yet. Create your first sprint to start planning.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={cancelTarget !== null}
        onConfirm={() => cancelTarget && handleCancel(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
        title="Cancel Sprint"
        description="This will uncommit all missions and mark the sprint as cancelled. This cannot be undone."
        confirmLabel="Cancel Sprint"
        variant="danger"
      />
    </Drawer>
  );
}

function SprintCard({
  sprint,
  expanded,
  onToggle,
  habitatFeatures,
  acting,
  missionLoading,
  onStart,
  onComplete,
  onCancelRequest,
  onAddMission,
  onRemoveMission,
  habitatId,
}: {
  sprint: Sprint;
  expanded: boolean;
  onToggle: () => void;
  habitatFeatures: Pick<MissionWithProgress, "id" | "title">[];
  acting: string | null;
  missionLoading: string | null;
  onStart: (id: string) => void;
  onComplete: (id: string) => void;
  onCancelRequest: (id: string) => void;
  onAddMission: (sprintId: string, missionId: string) => void;
  onRemoveMission: (sprintId: string, missionId: string) => void;
  habitatId: string;
}) {
  const isActing = acting === sprint.id;

  const availableFeatures = useMemo(
    () => habitatFeatures.filter((f) => !sprint.committedMissionIds.includes(f.id)),
    [habitatFeatures, sprint.committedMissionIds],
  );

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{sprint.name}</span>
              <SprintBadge
                sprintName={STATUS_LABELS[sprint.status] ?? sprint.status}
                sprintStatus={sprint.status}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {sprint.startDate} → {sprint.endDate} · {sprint.committedMissionIds.length} mission
              {sprint.committedMissionIds.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {sprint.status === "planning" && (
            <Button
              size="sm"
              onClick={() => onStart(sprint.id)}
              loading={isActing}
              disabled={!!acting}
            >
              <Play className="h-3 w-3" /> Start
            </Button>
          )}
          {sprint.status === "active" && (
            <Button
              size="sm"
              variant="success"
              onClick={() => onComplete(sprint.id)}
              loading={isActing}
              disabled={!!acting}
            >
              <CheckCircle className="h-3 w-3" /> Complete
            </Button>
          )}
          {(sprint.status === "planning" || sprint.status === "active") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCancelRequest(sprint.id)}
              disabled={!!acting}
            >
              <XCircle className="h-3 w-3" />
            </Button>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-3">
          {(sprint.status === "active" || sprint.status === "planning") && (
            <SprintDashboard sprint={sprint} habitatId={habitatId} />
          )}

          <SprintAnalyticsPanel sprintId={sprint.id} />

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Committed Missions</p>
            {sprint.committedMissionIds.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No missions assigned</p>
            ) : (
              <div className="space-y-1">
                {sprint.committedMissionIds.map((mId) => {
                  const feat = habitatFeatures.find((f) => f.id === mId);
                  return (
                    <div
                      key={mId}
                      className="flex items-center justify-between rounded px-2 py-1 bg-muted/50"
                    >
                      <span className="text-xs truncate">
                        {feat?.title ?? truncateId(mId, "FEAT")}
                      </span>
                      {sprint.status === "planning" && (
                        <button
                          type="button"
                          className="text-[10px] text-destructive hover:text-destructive/80"
                          onClick={() => onRemoveMission(sprint.id, mId)}
                          disabled={missionLoading === mId}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {sprint.status === "planning" && (
              <div className="mt-2">
                <p className="text-[10px] text-muted-foreground mb-1">Add missions:</p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {availableFeatures.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className="w-full flex items-center justify-between rounded px-2 py-1 text-left hover:bg-muted transition-colors"
                      onClick={() => onAddMission(sprint.id, f.id)}
                      disabled={missionLoading === f.id}
                    >
                      <span className="text-xs truncate">{f.title}</span>
                      <Plus className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    </button>
                  ))}
                  {availableFeatures.length === 0 && (
                    <p className="text-[10px] text-muted-foreground italic">
                      All missions already assigned
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
