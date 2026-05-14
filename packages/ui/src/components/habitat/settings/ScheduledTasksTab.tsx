import React, { useState, useEffect, useCallback } from 'react';
import { ScheduledTasksList } from './ScheduledTasksList.js';
import { ScheduledTaskForm, type ScheduledTaskFormData } from './ScheduledTaskForm.js';
import { api } from '../../../api/index.js';
import { notify } from '../../../lib/toast.js';
import type { ScheduledTask, FeatureTemplate } from '../../../types/index.js';

interface ScheduledTasksTabProps {
  boardId: string;
}

export function ScheduledTasksTab({ boardId }: ScheduledTasksTabProps) {
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [templates, setTemplates] = useState<FeatureTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const loadScheduledTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.scheduledTasks.list(boardId);
      setScheduledTasks(result.scheduledTasks);
    } catch (err) {
      notify.error('Failed to load scheduled tasks');
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  const loadTemplates = useCallback(async () => {
    try {
      const result = await api.templates.list(boardId);
      setTemplates(result.templates);
    } catch {
      // templates are optional for the form
    }
  }, [boardId]);

  useEffect(() => {
    loadScheduledTasks();
    loadTemplates();
  }, [loadScheduledTasks, loadTemplates]);

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
        await api.scheduledTasks.create(boardId, data);
        notify.success('Scheduled task created');
      }
      closeForm();
      loadScheduledTasks();
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
      loadScheduledTasks();
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
      loadScheduledTasks();
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
      loadScheduledTasks();
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
