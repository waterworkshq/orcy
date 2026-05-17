import React, { useEffect, useState } from 'react';
import { useHabitatStore } from '../../store/habitatStore.js';
import { useModalStore } from '../../store/modalStore.js';
import { useMissionDetails } from '../../lib/useHabitatData.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { Button } from '../ui/Button.js';
import { Badge } from '../ui/Badge.js';
import { CreateTaskForm } from './CreateTaskForm.js';
import { X, Plus, Sparkles, Trash2, ChevronRight, Clock, CheckCircle, AlertCircle, Loader2, Archive, RefreshCw } from 'lucide-react';
import type { Task, MissionWithProgress, MissionDecompositionResult } from '../../types/index.js';

const taskStatusVariant: Record<string, string> = {
  pending: 'pending',
  claimed: 'claimed',
  in_progress: 'in_progress',
  submitted: 'submitted',
  approved: 'approved',
  rejected: 'rejected',
  done: 'done',
  failed: 'failed',
};

export function FeatureDetailPanel() {
  const { selectedMissionId, setSelectedMission, features, columns } = useHabitatStore();
  const { data: detailsData, isLoading } = useMissionDetails(selectedMissionId ?? undefined);
  const feature = features.find((f) => f.id === selectedMissionId);

  const [showCreateTask, setShowCreateTask] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  if (!selectedMissionId || !feature) return null;

  const tasks = detailsData?.tasks ?? [];
  const events = detailsData?.events ?? [];
  const progress = detailsData?.progress;
  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? 0;
  const percentage = progress?.percentage ?? 0;

  function handleTaskClick(taskId: string) {
    useModalStore.getState().openModal(taskId);
  }

  async function handleDelete() {
    try {
      await api.missions.delete(feature!.id);
      setSelectedMission(null);
      notify.success('Mission deleted');
    } catch (err) {
      notify.error((err as Error).message);
    }
    setDeleteDialogOpen(false);
  }

  async function handleDecompose() {
    setDecomposing(true);
    try {
      const result = await api.missions.decompose(feature!.id) as MissionDecompositionResult;
      notify.success(`Created ${result.tasks.length} tasks`);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setDecomposing(false);
    }
  }

  async function handleArchive() {
    try {
      await api.missions.archive(feature!.id);
      useHabitatStore.getState().removeFeature(feature!.id);
      setSelectedMission(null);
      notify.success('Mission archived');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleRestore() {
    try {
      await api.missions.unarchive(feature!.id);
      useHabitatStore.getState().addFeature({ ...feature!, isArchived: false } as MissionWithProgress);
      notify.success('Mission restored');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold truncate">{feature.title}</h2>
        <Button variant="ghost" size="icon" onClick={() => setSelectedMission(null)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {!isLoading && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {feature.description && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-1">Description</h3>
              <p className="text-sm whitespace-pre-wrap">{feature.description}</p>
            </div>
          )}

          {feature.acceptanceCriteria && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-1">Acceptance Criteria</h3>
              <p className="text-sm whitespace-pre-wrap">{feature.acceptanceCriteria}</p>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={feature.priority as any}>{feature.priority}</Badge>
            <Badge variant={taskStatusVariant[feature.status] as any}>{feature.status.replace('_', ' ')}</Badge>
            {feature.labels.map((label: string) => (
              <span key={label} className="rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground">
                {label}
              </span>
            ))}
          </div>

          {total > 0 && (
            <div>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="font-medium">Progress</span>
                <span className="text-muted-foreground">{completed}/{total} ({percentage}%)</span>
              </div>
              <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${percentage}%` }}
                />
              </div>
              {progress?.byStatus && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {Object.entries(progress.byStatus).map(([status, count]) => (
                    <span key={status} className="text-xs text-muted-foreground">
                      {status.replace('_', ' ')}: {count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Tasks ({total})</h3>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={handleDecompose} disabled={decomposing || !feature.description}>
                  {decomposing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  AI Decompose
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowCreateTask(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  Add Task
                </Button>
              </div>
            </div>

            {tasks.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No tasks yet. Add tasks manually or use AI Decompose.
              </p>
            )}

            <div className="space-y-1">
              {tasks.sort((a, b) => a.order - b.order).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => handleTaskClick(task.id)}
                  className="w-full flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Badge variant={taskStatusVariant[task.status] as any} className="text-[10px] px-1.5 py-0 shrink-0">
                      {task.status.replace('_', ' ')}
                    </Badge>
                    <span className="truncate">{task.title}</span>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          </div>

          {feature.dependsOn.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-1">Dependencies</h3>
              <p className="text-sm">{feature.dependsOn.length} mission(s) this depends on</p>
            </div>
          )}

          {events.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-1">Timeline</h3>
              <div className="space-y-1">
                {events.slice(0, 10).map((event) => (
                  <div key={event.id} className="text-xs text-muted-foreground">
                    <span className="font-medium">{event.action}</span>
                    {' · '}
                    {new Date(event.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pt-2 border-t flex flex-col gap-2">
            {feature.status === 'done' && !feature.isArchived && (
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={handleArchive}
              >
                <Archive className="h-3.5 w-3.5 mr-2" />
                Archive Mission
              </Button>
            )}
            
            {feature.isArchived && (
              <Button
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={handleRestore}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                Restore Mission
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive justify-start"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete Mission
            </Button>
          </div>

          {deleteDialogOpen && (
            <div className="rounded border border-destructive/50 bg-destructive/5 p-3 space-y-2">
              <p className="text-sm">Delete "{feature.title}"? This will also delete all tasks within.</p>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={handleDelete}>Delete</Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {showCreateTask && (
        <CreateTaskForm
          open={showCreateTask}
          onClose={() => setShowCreateTask(false)}
          missionId={feature.id}
        />
      )}
    </div>
  );
}
