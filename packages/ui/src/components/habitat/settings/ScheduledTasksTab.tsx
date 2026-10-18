import React, { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ScheduledTasksList } from './ScheduledTasksList.js';
import { ScheduledTaskForm, type ScheduledTaskFormData } from './ScheduledTaskForm.js';
import { api } from '../../../api/index.js';
import { ApiError } from '../../../api/transport.js';
import { notify } from '../../../lib/toast.js';
import { useScheduledTasks, useTemplates } from '../../../lib/useHabitatData.js';
import { queryKeys } from '../../../lib/queryKeys.js';
import type { ScheduledTask } from '../../../types/index.js';

interface ScheduledTasksTabProps {
  habitatId: string;
}

export function ScheduledTasksTab({ habitatId }: ScheduledTasksTabProps) {
  const credential = localStorage.getItem('orcy_token');
  return <ScheduledTasksView key={`${habitatId}:${credential ?? ''}`} habitatId={habitatId} credential={credential} />;
}

function ScheduledTasksView({ habitatId, credential }: ScheduledTasksTabProps & { credential: string | null }) {
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const isCurrentView = () => active.current && localStorage.getItem('orcy_token') === credential;
  const { data: scheduledTasksData, isLoading: loading } = useScheduledTasks(habitatId);
  const { data: templatesData } = useTemplates(habitatId);
  const qc = useQueryClient();

  const scheduledTasks = scheduledTasksData?.scheduledTasks ?? [];
  const templates = templatesData?.templates ?? [];

  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null);
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [retryIds, setRetryIds] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const requests = useRef<Record<string, string>>({});

  const invalidateScheduledTasks = (throwOnError = false) =>
    throwOnError
      ? qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(habitatId) }, { throwOnError: true })
      : qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(habitatId) });

  function openForm(existing?: ScheduledTask) {
    setEditTask(existing ?? null);
    setFormOpen(true);
  }

  function closeForm() {
    setEditTask(null);
    setFormOpen(false);
  }

  async function handleSave(data: ScheduledTaskFormData) {
    setSaving(true);
    try {
      if (editTask) {
        await api.scheduledTasks.update(editTask.id, data);
        if (!isCurrentView()) return;
        notify.success('Scheduled task updated');
      } else {
        await api.scheduledTasks.create(habitatId, data);
        if (!isCurrentView()) return;
        notify.success('Scheduled task created');
      }
      closeForm();
      invalidateScheduledTasks();
    } catch (err) {
      if (!isCurrentView()) return;
      notify.error((err as Error).message);
    } finally {
      if (!isCurrentView()) return;
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.scheduledTasks.delete(id);
      if (!isCurrentView()) return;
      notify.success('Scheduled task deleted');
      invalidateScheduledTasks();
    } catch (err) {
      if (!isCurrentView()) return;
      notify.error((err as Error).message);
    }
  }

  async function handleRun(id: string) {
    if (inFlight.current.has(id)) return;
    const coordinate = requests.current[id] ?? scheduledTasks.find((task) => task.id === id)?.nextRunAt;
    if (coordinate === undefined) return;
    requests.current[id] = coordinate;
    inFlight.current.add(id);
    setRunningIds(new Set(inFlight.current));
    try {
      const result = await api.scheduledTasks.run(id, coordinate);
      if (!isCurrentView()) return;
      if (!result || typeof result.success !== 'boolean' ||
          typeof result.occurrenceId !== 'string' || result.scheduledFor !== coordinate ||
          !['published', 'rejected', 'reserved', 'publishing'].includes(result.occurrenceState ?? '')) {
        throw new Error('Run result was not confirmed');
      }
      if (result.occurrenceState === 'reserved' || result.occurrenceState === 'publishing') {
        setRetryIds((previous) => new Set(previous).add(id));
        notify.info('Run reserved; publication is pending. Retry Run checks the same request.');
      } else {
        delete requests.current[id];
        setRetryIds((previous) => { const next = new Set(previous); next.delete(id); return next; });
        if (!result.success || result.occurrenceState === 'rejected') {
          notify.error(result.error ?? 'Execution failed');
        } else if (result.replayed) {
          notify.success(result.missionId ? 'Previous run completed — mission available' : 'Previous run completed');
        } else {
          notify.success(result.missionId ? 'Scheduled task completed — mission available' : 'Scheduled task completed');
        }
      }
      invalidateScheduledTasks();
    } catch (err) {
      if (!isCurrentView()) return;
      const code = err instanceof ApiError && err.body && typeof err.body === 'object' && 'code' in err.body
        ? (err.body as { code?: unknown }).code : undefined;
      // These decisions follow authorized pair lookup and prove this exact
      // request was not reserved. Auth/unknown errors cannot resolve old work.
      const definitive = err instanceof ApiError && typeof code === 'string' &&
        ((err.status === 400 && code === 'SCHEDULE_RUN_INVALID') ||
          (err.status === 409 && ['SCHEDULE_RUN_STALE', 'SCHEDULE_DISABLED', 'ONCE_SCHEDULE_CONSUMED',
            'ONCE_SCHEDULE_HISTORY_UNKNOWN', 'SCHEDULE_RUN_REJECTED', 'SCHEDULE_RUN_CONFLICT'].includes(code)));
      if (definitive) {
        try {
          await invalidateScheduledTasks(true);
        } catch {
          if (!isCurrentView()) return;
          setRetryIds((previous) => new Set(previous).add(id));
          notify.error(`${(err as Error).message}. Schedule refresh failed; Retry Run will recheck this slot.`);
          return;
        }
        if (!isCurrentView()) return;
        delete requests.current[id];
        setRetryIds((previous) => { const next = new Set(previous); next.delete(id); return next; });
      } else {
        setRetryIds((previous) => new Set(previous).add(id));
      }
      notify.error(definitive ? (err as Error).message : `${(err as Error).message}. Result unconfirmed; Retry Run checks the same request.`);
    } finally {
      if (!isCurrentView()) return;
      inFlight.current.delete(id);
      setRunningIds(new Set(inFlight.current));
    }
  }

  async function handleToggle(task: ScheduledTask) {
    try {
      if (task.enabled) {
        await api.scheduledTasks.disable(task.id);
      } else {
        await api.scheduledTasks.enable(task.id);
      }
      if (!isCurrentView()) return;
      invalidateScheduledTasks();
    } catch (err) {
      if (!isCurrentView()) return;
      notify.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      {formOpen ? (
        <ScheduledTaskForm
          existing={editTask}
          templates={templates}
          saving={saving}
          onSave={handleSave}
          onCancel={closeForm}
        />
      ) : (
        <ScheduledTasksList
          scheduledTasks={scheduledTasks}
          loading={loading}
          runningId={null}
          runningIds={runningIds}
          retryIds={retryIds}
          onToggle={handleToggle}
          onRun={handleRun}
          onDelete={handleDelete}
          onEdit={(task) => openForm(task)}
          onAdd={() => openForm()}
        />
      )}
    </div>
  );
}
