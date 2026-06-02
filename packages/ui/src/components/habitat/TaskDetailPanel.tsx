import { useHabitatStore } from "../../store/habitatStore.js";
import { useModalStore } from "../../store/modalStore.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { X, ArrowLeft } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReviewPanel } from "./ReviewPanel.js";
import { CommentSection } from "./CommentSection.js";
import { AttachmentSection } from "./AttachmentSection.js";
import { useTaskDetailPanel } from "../../hooks/useTaskDetailPanel.js";
import { TaskEditForm } from "./TaskEditForm.js";
import { TaskViewHeader } from "./TaskViewHeader.js";
import { TaskAssignment } from "./TaskAssignment.js";
import { TaskSubtasks } from "./TaskSubtasks.js";
import { TaskQualityChecklist } from "./TaskQualityChecklist.js";
import { TaskDependencies } from "./TaskDependencies.js";
import { TaskTimeInfo } from "./TaskTimeInfo.js";
import { TaskActivity } from "./TaskActivity.js";
import { TaskRetryPolicy } from "./TaskRetryPolicy.js";
import { TaskCodeEvidence } from "./TaskCodeEvidence.js";
import { TaskDangerZone } from "./TaskDangerZone.js";
import { TaskDescription } from "./TaskDescription.js";
import { TaskResultCard } from "./TaskResultCard.js";
import { TaskArtifacts } from "./TaskArtifacts.js";
import { TaskTimeConstraints } from "./TaskTimeConstraints.js";
import { TaskEffortSection } from "./TaskEffortSection.js";
import { FeatureContextSection } from "./MissionContextSection.js";
import { SiblingTasksSection } from "./SiblingTasksSection.js";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";

export function TaskDetailPanel({ editTaskId }: { editTaskId?: string | null }) {
  const { selectedMissionId, tasks } = useHabitatStore();
  const { openModal, closeModal } = useModalStore();
  const p = useTaskDetailPanel({ editTaskId });
  const queryClient = useQueryClient();

  const { data: qualityReport, isLoading: qualityLoading } = useQuery({
    queryKey: queryKeys.tasks.quality(p.selectedTaskId ?? ""),
    queryFn: () => api.qualityGates.getReport(p.selectedTaskId!),
    enabled: !!p.selectedTaskId,
  });

  async function handleToggleQualityItem(
    checklistId: string,
    itemId: string,
    isCompleted: boolean,
  ) {
    if (!p.selectedTaskId) return;
    try {
      await api.qualityGates.updateItem(p.selectedTaskId, checklistId, itemId, { isCompleted });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.quality(p.selectedTaskId) });
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to update quality checklist");
    }
  }

  function handleBack() {
    closeModal();
  }

  if (!p.selectedTaskId) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          {selectedMissionId && (
            <Button variant="ghost" size="icon" onClick={handleBack} title="Back to feature">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <h2 className="font-semibold">Task Details</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={() => closeModal()}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {p.contextLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {!p.contextLoading && p.task && (
        <div className="flex-1 overflow-y-auto p-4">
          {p.feature && (
            <FeatureContextSection
              feature={p.feature}
              onSelectFeature={() => {
                closeModal();
              }}
            />
          )}
          {p.siblingTasks.length > 0 && (
            <SiblingTasksSection
              siblingTasks={p.siblingTasks}
              onSelectTask={(taskId) => openModal(taskId)}
            />
          )}
          <div className="mb-4">
            {p.isEditing ? (
              <TaskEditForm
                editForm={p.editForm}
                editDueAt={p.editDueAt}
                editSlaMinutes={p.editSlaMinutes}
                editEstimatedMinutes={p.editEstimatedMinutes}
                retryForm={p.retryForm}
                onFormChange={p.setEditForm}
                onDueAtChange={p.setEditDueAt}
                onSlaMinutesChange={p.setEditSlaMinutes}
                onEstimatedMinutesChange={p.setEditEstimatedMinutes}
                onRetryFormChange={p.setRetryForm}
                onSubmit={p.handleEditSubmit}
                onCancel={p.handleEditCancel}
              />
            ) : (
              <TaskViewHeader
                task={p.task}
                isWatching={p.isWatching}
                watchLoading={p.watchLoading}
                onToggleWatch={() => p.handleToggleWatch(p.isWatching)}
                onEdit={p.startEditing}
                columnName={p.column?.name}
              />
            )}
          </div>

          {p.task.requiredCapabilities && p.task.requiredCapabilities.length > 0 && (
            <div className="mb-4 space-y-2">
              <span className="text-xs text-on-surface-variant">Capabilities</span>
              <div className="flex flex-wrap gap-1">
                {p.task.requiredCapabilities.map((cap) => (
                  <Badge key={cap} className="text-[10px]">
                    {cap}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <TaskDescription description={p.task.description} />

          <TaskRetryPolicy
            task={{
              retryPolicy: p.task.retryPolicy,
              retryCount: p.task.retryCount,
              nextRetryAt: p.task.nextRetryAt,
            }}
          />

          <TaskTimeInfo
            task={{
              status: p.task.status,
              claimedAt: p.task.claimedAt,
              startedAt: p.task.startedAt,
              completedAt: p.task.completedAt,
              estimatedMinutes: p.task.estimatedMinutes,
              actualMinutes: p.task.actualMinutes,
              cycleTimeMinutes: p.task.cycleTimeMinutes,
              leadTimeMinutes: p.task.leadTimeMinutes,
              estimationAccuracy: p.task.estimationAccuracy,
            }}
          />

          <TaskResultCard
            result={p.task.result}
            rejectionReason={p.task.rejectionReason}
            rejectedCount={p.task.rejectedCount}
          />

          <TaskArtifacts artifacts={p.task.artifacts} />

          <TaskTimeConstraints
            estimatedMinutes={p.task.estimatedMinutes}
            actualMinutes={p.task.actualMinutes}
          />

          <TaskEffortSection taskId={p.task.id} />

          <TaskSubtasks
            subtasks={p.subtasks}
            contextLoading={p.contextLoading}
            newSubtaskTitle={p.newSubtaskTitle}
            addingSubtask={p.addingSubtask}
            onTitleChange={p.setNewSubtaskTitle}
            onAdd={p.handleAddSubtask}
            onToggle={p.handleToggleSubtask}
            onDelete={p.handleDeleteSubtask}
          />

          <TaskQualityChecklist
            taskId={p.selectedTaskId ?? ""}
            report={qualityReport ?? null}
            loading={qualityLoading}
            onToggleItem={handleToggleQualityItem}
          />

          <TaskDependencies
            task={{ dependsOn: p.dependencies.map((d) => d.id) }}
            taskId={p.task.id}
            dependencies={p.dependencies}
            crossHabitatDependsOn={p.crossHabitatDependsOn}
            blockedBy={p.blockedBy}
            blocking={p.blocking}
            boardTasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }))}
            onSelectTask={(id) => openModal(id)}
            onAddDependency={p.handleAddDependency}
            onRemoveDependency={p.handleRemoveDependency}
            addingDep={p.addingDep}
          />

          <TaskAssignment
            task={{
              assignedAgentId: p.task.assignedAgentId,
              delegatedToAgentId: p.task.delegatedToAgentId,
              status: p.task.status,
            }}
            agents={p.agents}
            showDelegate={p.showDelegate}
            delegateAgentId={p.delegateAgentId}
            delegating={p.delegating}
            onShowDelegate={p.setShowDelegate}
            onDelegateAgentIdChange={p.setDelegateAgentId}
            onDelegate={p.handleDelegate}
          />

          {p.task.status === "submitted" && (
            <ReviewPanel
              taskId={p.task.id}
              result={p.task.result ?? ""}
              artifacts={p.task.artifacts}
              autoAdvance={p.column?.autoAdvance}
              nextColumnName={p.nextColumnName}
              onApprove={p.handleApprove}
              onReject={p.handleReject}
              isSubmitting={p.submitting}
              reviewers={p.reviewers}
              currentUserId={p.currentUserId}
              currentUserIsReviewer={p.currentUserIsReviewer}
              reviewProgress={p.reviewProgress}
              agents={p.agents}
            />
          )}

          <TaskActivity events={p.events} agents={p.agents} />
          <AttachmentSection taskId={p.task.id} attachments={p.attachments} />
          <TaskCodeEvidence taskId={p.task.id} />
          <CommentSection taskId={p.task.id} initialComments={p.comments} />

          <TaskDangerZone
            task={{ title: p.task.title, description: p.task.description }}
            decomposing={p.decomposing}
            decomposeDialogOpen={p.decomposeDialogOpen}
            decompositionProposals={p.decompositionProposals}
            deleteDialogOpen={p.deleteDialogOpen}
            onDecompose={p.handleDecompose}
            onDecomposeConfirm={p.handleDecomposeConfirm}
            onDecomposeDialogClose={() => p.setDecomposeDialogOpen(false)}
            onClone={p.handleClone}
            onDelete={p.handleDelete}
            onDeleteDialogOpen={p.setDeleteDialogOpen}
          />
        </div>
      )}
    </div>
  );
}
