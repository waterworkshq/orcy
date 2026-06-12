import { useModalStore } from "../store/modalStore.js";
import { useHabitatStore } from "../store/habitatStore.js";
import { useTaskDetails } from "../lib/useTaskData.js";
import { useMission } from "../lib/useHabitatData.js";
import { useTaskEdit, type UseTaskEditResult } from "./useTaskEdit.js";
import { useTaskSubtasks } from "./useTaskSubtasks.js";
import { useTaskDelegate } from "./useTaskDelegate.js";
import { useTaskDecompose } from "./useTaskDecompose.js";
import { useTaskDependencies } from "./useTaskDependencies.js";
import { useTaskReview } from "./useTaskReview.js";
import { useTaskActions } from "./useTaskActions.js";
import { useTaskWatch } from "./useTaskWatch.js";
import type {
  Task,
  Subtask,
  SubtaskProposal,
  Agent,
  TaskEvent,
  PullRequest,
  PipelineEvent,
  TaskAttachment,
  TaskComment,
  CrossHabitatDependency,
  TaskReviewer,
} from "../types/index.js";

export interface UseTaskDetailPanelOptions {
  editTaskId?: string | null;
}

export interface UseTaskDetailPanelResult {
  // State
  submitting: boolean;
  isEditing: boolean;
  watchLoading: boolean;
  deleteDialogOpen: boolean;
  editForm: UseTaskEditResult["editForm"];
  editDueAt: string;
  editSlaMinutes: string;
  editEstimatedMinutes: string;
  retryForm: UseTaskEditResult["retryForm"];
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
  setEditForm: UseTaskEditResult["setEditForm"];
  setEditDueAt: (v: string) => void;
  setEditSlaMinutes: (v: string) => void;
  setEditEstimatedMinutes: (v: string) => void;
  setRetryForm: UseTaskEditResult["setRetryForm"];
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
  reviewers: TaskReviewer[];
  currentUserId: string | undefined;
  currentUserIsReviewer: boolean;
  reviewProgress: { approved: number; total: number };
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
  feature: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
    status: string;
  } | null;
  siblingTasks: { id: string; title: string; status: string; result: string | null }[];
  column:
    | { id: string; name: string; nextColumnId: string | null; autoAdvance: boolean }
    | undefined;
  nextColumnName: string | undefined;
  contextLoading: boolean;
  events: TaskEvent[];
  subtasks: Subtask[];
  pullRequests: PullRequest[];
  pipelineEvents: PipelineEvent[];
  attachments: TaskAttachment[];
  isWatching: boolean;
  dependencies: Task[];
  crossHabitatDependsOn: CrossHabitatDependency[];
  blockedBy: Task[];
  blocking: Task[];
  comments: TaskComment[];
}

export function useTaskDetailPanel({
  editTaskId,
}: UseTaskDetailPanelOptions = {}): UseTaskDetailPanelResult {
  const { tasks, agents } = useHabitatStore();
  const selectedTaskId = useModalStore((s) => s.selectedTaskId);
  const { data: detailsData, isLoading: contextLoading } = useTaskDetails(
    selectedTaskId ?? undefined,
  );

  const task = detailsData?.task ?? tasks.find((t) => t.id === selectedTaskId);
  const columns = useHabitatStore((s) => s.columns);
  const { data: missionData } = useMission(task?.missionId);
  const mission = missionData?.feature;
  const column = mission ? columns.find((c) => c.id === mission.columnId) : undefined;
  const nextColumnName = column?.nextColumnId
    ? columns.find((c) => c.id === column.nextColumnId)?.name
    : undefined;

  const edit = useTaskEdit(task, editTaskId, selectedTaskId, detailsData);
  const subtasks = useTaskSubtasks(task);
  const delegate = useTaskDelegate(task);
  const decompose = useTaskDecompose(task);
  const deps = useTaskDependencies(selectedTaskId);
  const review = useTaskReview(task);
  const actions = useTaskActions(task);
  const watch = useTaskWatch(task);

  return {
    ...edit,
    ...subtasks,
    ...delegate,
    ...decompose,
    ...deps,
    ...review,
    ...actions,
    ...watch,
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
    crossHabitatDependsOn: detailsData?.crossHabitatDependsOn ?? [],
    blockedBy: detailsData?.blockedBy ?? [],
    blocking: detailsData?.blocking ?? [],
    comments: detailsData?.comments ?? [],
  };
}
