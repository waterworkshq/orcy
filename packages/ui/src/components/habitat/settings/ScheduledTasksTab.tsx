import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ScheduledTasksList } from './ScheduledTasksList.js';
import { ScheduledTaskForm, type ScheduledTaskFormData } from './ScheduledTaskForm.js';
import { api } from '../../../api/index.js';
import { notify } from '../../../lib/toast.js';
import { useScheduledTasks, useTemplates } from '../../../lib/useHabitatData.js';
import { queryKeys } from '../../../lib/queryKeys.js';
import type { ScheduledTask } from '../../../types/index.js';

interface ScheduledTasksTabProps {
  habitatId: string;
}

export function ScheduledTasksTab({ habitatId }: ScheduledTasksTabProps) {
  const { data: scheduledTasksData, isLoading: loading } = useScheduledTasks(habitatId);
  const { data: templatesData } = useTemplates(habitatId);
  const qc = useQueryClient();

  const scheduledTasks = scheduledTasksData?.scheduledTasks ?? [];
  const templates = templatesData?.templates ?? [];

  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const invalidateScheduledTasks = () =>
    qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list(habitatId) });

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
        notify.success('Scheduled task updated');
      } else {
        await api.scheduledTasks.create(habitatId, data);
        notify.success('Scheduled task created');
      }
      closeForm();
      invalidateScheduledTasks();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.scheduledTasks.delete(id);
      notify.success('Scheduled task deleted');
      invalidateScheduledTasks();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleRun(id: string) {
    setRunningId(id);
    try {
      const result = await api.scheduledTasks.run(id);
      if (result.success) {
        notify.success(`Scheduled task executed — feature created`);
      } else {
        notify.error(result.error ?? 'Execution failed');
      }
      invalidateScheduledTasks();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setRunningId(null);
    }
  }

  async function handleToggle(task: ScheduledTask) {
    try {
      if (task.enabled) {
        await api.scheduledTasks.disable(task.id);
      } else {
        await api.scheduledTasks.enable(task.id);
      }
      invalidateScheduledTasks();
    } catch (err) {
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
          runningId={runningId}
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
