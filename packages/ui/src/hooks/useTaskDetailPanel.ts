import { useState, useEffect } from 'react';
import { useBoardStore } from '../store/habitatStore.js';
import { useModalStore } from '../store/modalStore.js';
import { api } from '../api/index.js';
import { notify } from '../lib/toast.js';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { useTaskDetails } from '../lib/useTaskData.js';
import type { Task, Subtask, SubtaskProposal, Agent, TaskEvent, PullRequest, PipelineEvent, TaskAttachment, TaskComment, CrossBoardDependency } from '../types/index.js';
import { initEditForm } from '../lib/task-helpers.js';

interface EditFormState {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  labels: string;
  requiredDomain: string;
  requiredCapabilities: string[];
}

interface RetryFormState {
  maxRetries: string;
  backoffBase: string;
  backoffMultiplier: string;
  maxBackoff: string;
  escalateToHuman: boolean;
}

export interface UseTaskDetailPanelOptions {
  editTaskId?: string | null;
}

export interface UseTaskDetailPanelResult {
  // State
  submitting: boolean;
  isEditing: boolean;
  watchLoading: boolean;
  deleteDialogOpen: boolean;
  editForm: EditFormState;
  editDueAt: string;
  editSlaMinutes: string;
  editEstimatedMinutes: string;
  retryForm: RetryFormState;
  newSubtaskTitle: string;
  addingSubtask: boolean;
  delegateAgentId: string;
  delegating: boolean;
  showDelegate: boolean;
  decomposing: boolean;
  decomposeDialogOpen: boolean;
  decompositionProposals: SubtaskProposal[];

  // Actions
  setIsEditing: (v: boolean) => void;
  setDeleteDialogOpen: (v: boolean) => void;
  setEditForm: (f: EditFormState) => void;
  setEditDueAt: (v: string) => void;
  setEditSlaMinutes: (v: string) => void;
  setEditEstimatedMinutes: (v: string) => void;
  setRetryForm: (f: RetryFormState) => void;
  setNewSubtaskTitle: (v: string) => void;
  setDelegateAgentId: (v: string) => void;
  setShowDelegate: (v: boolean) => void;
  setDecomposeDialogOpen: (v: boolean) => void;
  setDecompositionProposals: (v: SubtaskProposal[]) => void;

  // Handlers
  startEditing: () => void;
  handleAddSubtask: (e: React.FormEvent) => Promise<void>;
  handleToggleSubtask: (subtask: Subtask) => Promise<void>;
  handleDeleteSubtask: (subtask: Subtask) => Promise<void>;
  handleApprove: (reviewerId: string) => Promise<void>;
  handleReject: (reviewerId: string, reason: string) => Promise<void>;
  handleDelete: () => Promise<void>;
  handleClone: () => Promise<void>;
  handleDecompose: () => Promise<void>;
  handleDecomposeConfirm: (proposals: SubtaskProposal[]) => Promise<void>;
  handleDelegate: () => Promise<void>;
  handleToggleWatch: (isWatching: boolean) => Promise<void>;
  handleEditSubmit: () => Promise<void>;
  handleEditCancel: () => void;

  addingDep: boolean;
  handleAddDependency: (dependsOnTaskId: string) => Promise<void>;
  handleRemoveDependency: (depTaskId: string) => Promise<void>;

  // Derived
  selectedTaskId: string | null;
  agents: Agent[];
  task: Task | undefined;
  feature: { id: string; title: string; description: string; acceptanceCriteria: string; priority: string; status: string } | null;
  siblingTasks: { id: string; title: string; status: string; result: string | null }[];
  column: { id: string; name: string; nextColumnId: string | null; autoAdvance: boolean; } | undefined;
  nextColumnName: string | undefined;
  contextLoading: boolean;
  events: TaskEvent[];
  subtasks: Subtask[];
  pullRequests: PullRequest[];
  pipelineEvents: PipelineEvent[];
  attachments: TaskAttachment[];
  isWatching: boolean;
  dependencies: Task[];
  crossBoardDependsOn: CrossBoardDependency[];
  blockedBy: Task[];
  blocking: Task[];
  comments: TaskComment[];
}

export function useTaskDetailPanel({ editTaskId }: UseTaskDetailPanelOptions = {}): UseTaskDetailPanelResult {
  const { tasks, agents, updateTask, removeTask } = useBoardStore();
  const selectedTaskId = useModalStore((s) => s.selectedTaskId);
  const queryClient = useQueryClient();
  const { data: detailsData, isLoading: contextLoading } = useTaskDetails(selectedTaskId ?? undefined);

  const task = detailsData?.task ?? tasks.find((t) => t.id === selectedTaskId);
  const columns = useBoardStore((s) => s.columns);
  const features = useBoardStore((s) => s.features);
  const column = task
    ? (() => {
        const feat = features.find((f) => f.id === task.featureId);
        if (!feat) return undefined;
        return columns.find((c) => c.id === feat.columnId);
      })()
    : undefined;
  const nextColumnName = column?.nextColumnId
    ? columns.find((c) => c.id === column.nextColumnId)?.name
    : undefined;

  const [submitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [watchLoading, setWatchLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [editForm, setEditForm] = useState<EditFormState>({
    title: '', description: '', priority: 'medium', labels: '', requiredDomain: '', requiredCapabilities: [],
  });
  const [editDueAt, setEditDueAt] = useState('');
  const [editSlaMinutes, setEditSlaMinutes] = useState('');
  const [editEstimatedMinutes, setEditEstimatedMinutes] = useState('');

  const [retryForm, setRetryForm] = useState<RetryFormState>({
    maxRetries: '', backoffBase: '', backoffMultiplier: '', maxBackoff: '', escalateToHuman: true,
  });

  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [delegateAgentId, setDelegateAgentId] = useState('');
  const [delegating, setDelegating] = useState(false);
  const [showDelegate, setShowDelegate] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  const [decomposeDialogOpen, setDecomposeDialogOpen] = useState(false);
  const [decompositionProposals, setDecompositionProposals] = useState<SubtaskProposal[]>([]);
  const [addingDep, setAddingDep] = useState(false);

  useEffect(() => {
    if (editTaskId && editTaskId === selectedTaskId) {
      setIsEditing(true);
    }
  }, [editTaskId, selectedTaskId]);

  function startEditing() {
    if (!task) return;
    setEditForm(initEditForm(task));
    setEditDueAt(detailsData?.feature?.dueAt ?? '');
    setEditSlaMinutes(detailsData?.feature?.slaMinutes?.toString() ?? '');
    setEditEstimatedMinutes(task.estimatedMinutes?.toString() ?? '');
    setRetryForm({
      maxRetries: task.retryPolicy?.maxRetries?.toString() ?? '',
      backoffBase: task.retryPolicy?.backoffBase?.toString() ?? '',
      backoffMultiplier: task.retryPolicy?.backoffMultiplier?.toString() ?? '',
      maxBackoff: task.retryPolicy?.maxBackoff?.toString() ?? '',
      escalateToHuman: task.retryPolicy?.escalateToHuman ?? true,
    });
    setIsEditing(true);
  }

  async function handleAddSubtask(e: React.FormEvent) {
    e.preventDefault();
    if (!task || !newSubtaskTitle.trim()) return;
    setAddingSubtask(true);
    try {
      await api.subtasks.create(task.id, { title: newSubtaskTitle.trim() });
      setNewSubtaskTitle('');
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setAddingSubtask(false);
    }
  }

  async function handleToggleSubtask(subtask: Subtask) {
    if (!task) return;
    try {
      await api.subtasks.update(task.id, subtask.id, { completed: !subtask.completed });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.subtasks(task.id) });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleDeleteSubtask(subtask: Subtask) {
    if (!task) return;
    try {
      await api.subtasks.delete(task.id, subtask.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.subtasks(task.id) });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleApprove(reviewerId: string) {
    if (!task) return;
    setSubmitting(true);
    try {
      const result = await api.tasks.approve(task.id, reviewerId);
      updateTask(result.task);
      notify.success('Task approved');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject(reviewerId: string, reason: string) {
    if (!task) return;
    setSubmitting(true);
    try {
      const result = await api.tasks.reject(task.id, reviewerId, reason);
      updateTask(result.task);
      notify.success('Task rejected');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!task) return;
    try {
      await api.tasks.delete(task.id);
      removeTask(task.id);
      notify.success('Task deleted');
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function handleClone() {
    if (!task) return;
    try {
      await api.tasks.clone(task.id);
      notify.success('Task cloned');
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function handleDecompose() {
    if (!task || !task.description.trim()) return;
    setDecomposing(true);
    try {
      const result = await api.tasks.decompose(task.id);
      setDecompositionProposals(result.proposals);
      setDecomposeDialogOpen(true);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setDecomposing(false);
    }
  }

  async function handleDecomposeConfirm(proposals: SubtaskProposal[]) {
    if (!task) return;
    setDecomposeDialogOpen(false);
    let createdCount = 0;
    for (let i = 0; i < proposals.length; i++) {
      const proposal = proposals[i];
      try {
        await api.subtasks.create(task.id, {
          title: proposal.title,
          order: proposal.order,
        });
        createdCount++;
      } catch (e) {
        console.warn(`Failed to create subtask: ${proposal.title}`, e);
      }
    }
    notify.success(`Created ${createdCount} subtasks`);
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.subtasks(task.id) });
  }

  async function handleDelegate() {
    if (!task || !delegateAgentId) return;
    setDelegating(true);
    try {
      const result = await api.tasks.delegate(task.id, delegateAgentId);
      updateTask(result.task);
      const targetAgent = agents.find((a) => a.id === delegateAgentId);
      notify.success(`Task delegated to ${targetAgent?.name ?? 'agent'}`);
      setShowDelegate(false);
      setDelegateAgentId('');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setDelegating(false);
    }
  }

  async function handleToggleWatch(isWatching: boolean) {
    if (!task || watchLoading) return;
    setWatchLoading(true);
    try {
      if (isWatching) {
        await api.tasks.unwatch(task.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.watchers(task.id) });
        notify.success('Stopped watching task');
      } else {
        await api.tasks.watch(task.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.watchers(task.id) });
        notify.success('Now watching task');
      }
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setWatchLoading(false);
    }
  }

  async function handleEditSubmit() {
    if (!task) return;
    try {
      await api.tasks.update(task.id, {
        ...editForm,
        labels: editForm.labels.split(',').map(l => l.trim()).filter(Boolean),
        estimatedMinutes: editEstimatedMinutes ? parseInt(editEstimatedMinutes, 10) : null,
        retryPolicy: retryForm.maxRetries ? {
          maxRetries: parseInt(retryForm.maxRetries, 10),
          backoffBase: retryForm.backoffBase ? parseInt(retryForm.backoffBase, 10) : undefined,
          backoffMultiplier: retryForm.backoffMultiplier ? parseFloat(retryForm.backoffMultiplier) : undefined,
          maxBackoff: retryForm.maxBackoff ? parseInt(retryForm.maxBackoff, 10) : undefined,
          escalateToHuman: retryForm.escalateToHuman,
        } : null,
        version: task.version,
      });

      if (task.featureId && (editDueAt || editSlaMinutes)) {
        const featureUpdate: { dueAt?: string | null; slaMinutes?: number | null } = {};
        if (editDueAt) featureUpdate.dueAt = editDueAt;
        else featureUpdate.dueAt = null;
        if (editSlaMinutes) featureUpdate.slaMinutes = parseInt(editSlaMinutes, 10);
        else featureUpdate.slaMinutes = null;
        await api.features.update(task.featureId, featureUpdate);
      }

      const updatedLabels = editForm.labels.split(',').map(l => l.trim()).filter(Boolean);
      updateTask({ ...task, ...editForm, labels: updatedLabels });
      notify.success('Task updated');
      setIsEditing(false);
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  function handleEditCancel() {
    setIsEditing(false);
  }

  async function handleAddDependency(dependsOnTaskId: string) {
    if (!selectedTaskId) return;
    setAddingDep(true);
    try {
      await api.dependencies.addTaskDependency(selectedTaskId, dependsOnTaskId);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(selectedTaskId) });
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('409') || msg.toLowerCase().includes('circular')) {
        notify.error('Cannot add: would create a circular dependency');
      } else {
        throw err;
      }
    } finally {
      setAddingDep(false);
    }
  }

  async function handleRemoveDependency(depTaskId: string) {
    if (!selectedTaskId) return;
    try {
      await api.dependencies.removeTaskDependency(selectedTaskId, depTaskId);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(selectedTaskId) });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return {
    submitting,
    isEditing,
    watchLoading,
    deleteDialogOpen,
    editForm,
    editDueAt,
    editSlaMinutes,
    editEstimatedMinutes,
    retryForm,
    newSubtaskTitle,
    addingSubtask,
    delegateAgentId,
    delegating,
    showDelegate,
    decomposing,
    decomposeDialogOpen,
    decompositionProposals,
    setIsEditing,
    setDeleteDialogOpen,
    setEditForm,
    setEditDueAt,
    setEditSlaMinutes,
    setEditEstimatedMinutes,
    setRetryForm,
    setNewSubtaskTitle,
    setDelegateAgentId,
    setShowDelegate,
    setDecomposeDialogOpen,
    setDecompositionProposals,
    startEditing,
    handleAddSubtask,
    handleToggleSubtask,
    handleDeleteSubtask,
    handleApprove,
    handleReject,
    handleDelete,
    handleClone,
    handleDecompose,
    handleDecomposeConfirm,
    handleDelegate,
    handleToggleWatch,
    handleEditSubmit,
    handleEditCancel,
    addingDep,
    handleAddDependency,
    handleRemoveDependency,
    selectedTaskId,
    agents,
    task,
    feature: detailsData?.feature ?? null,
    siblingTasks: detailsData?.siblingTasks ?? [],
    column,
    nextColumnName,
    contextLoading,
    events: detailsData?.events ?? [],
    subtasks: detailsData?.subtasks ?? [],
    pullRequests: detailsData?.pullRequests ?? [],
    pipelineEvents: detailsData?.pipelineEvents ?? [],
    attachments: detailsData?.attachments ?? [],
    isWatching: detailsData?.isWatching ?? false,
    dependencies: detailsData?.dependencies ?? [],
    crossBoardDependsOn: detailsData?.crossBoardDependsOn ?? [],
    blockedBy: detailsData?.blockedBy ?? [],
    blocking: detailsData?.blocking ?? [],
    comments: detailsData?.comments ?? [],
  };
}
