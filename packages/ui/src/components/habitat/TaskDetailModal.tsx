import React, { useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useSessionLiveness } from "../../lib/sessionState.js";
import { X, Calendar, User, CheckSquare, Share2, Archive } from "lucide-react";
import { useModalStore } from "../../store/modalStore.js";
import { useTaskDetails } from "../../lib/useTaskData.js";
import { useAgents, useMissionTasks } from "../../lib/useHabitatData.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { TaskMetadataEditor, type MetadataEditOpening } from "./TaskMetadataEditor.js";
import { TaskArtifacts } from "./TaskArtifacts.js";
import { TaskDependencies } from "./TaskDependencies.js";
import { TaskActivityFeed } from "./TaskActivityFeed.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import {
  getAgentDisplayName,
  getActorDisplayName,
  formatTimestamp,
} from "../../lib/task-helpers.js";
import type { Agent, TaskEvent, TaskPriority, TaskStatus } from "../../types/index.js";
import type { ActivityEvent } from "./TaskActivityFeed.js";

const PRIORITY_CONFIG: Record<TaskPriority, { label: string; dotClass: string }> = {
  critical: {
    label: "Critical",
    dotClass: "bg-[var(--badge-critical)] shadow-[0_0_8px_rgba(139,69,69,0.35)]",
  },
  high: { label: "High", dotClass: "bg-[var(--badge-high)] shadow-[0_0_8px_rgba(139,69,83,0.35)]" },
  medium: {
    label: "Medium",
    dotClass: "bg-[var(--badge-medium)] shadow-[0_0_8px_rgba(139,113,69,0.35)]",
  },
  low: { label: "Low", dotClass: "bg-[var(--badge-low)] shadow-[0_0_8px_rgba(100,116,139,0.3)]" },
};

const STATUS_DISPLAY: Record<TaskStatus, { label: string; className: string }> = {
  pending: {
    label: "Pending",
    className: "bg-surface-container-high/60 text-on-surface-variant border-outline-variant/30",
  },
  claimed: {
    label: "Claimed",
    className:
      "bg-[var(--badge-active-bg)] text-[var(--badge-active-text)] border-[var(--badge-active)]",
  },
  in_progress: {
    label: "In Progress",
    className: "bg-primary-container/30 text-primary border-primary-container/50",
  },
  submitted: {
    label: "Submitted",
    className:
      "bg-[var(--badge-review-bg)] text-[var(--badge-review-text)] border-[var(--badge-review)]",
  },
  approved: {
    label: "Approved",
    className: "bg-[var(--badge-done-bg)] text-[var(--badge-done-text)] border-[var(--badge-done)]",
  },
  rejected: {
    label: "Rejected",
    className:
      "bg-[var(--badge-blocked-bg)] text-[var(--badge-blocked-text)] border-[var(--badge-blocked)]",
  },
  done: {
    label: "Done",
    className: "bg-[var(--badge-done-bg)] text-[var(--badge-done-text)] border-[var(--badge-done)]",
  },
  failed: {
    label: "Failed",
    className:
      "bg-[var(--badge-blocked-bg)] text-[var(--badge-blocked-text)] border-[var(--badge-blocked)]",
  },
};

function CustomScrollbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`overflow-y-auto custom-scrollbar ${className ?? ""}`}>{children}</div>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const config = STATUS_DISPLAY[status] ?? STATUS_DISPLAY.pending;
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1 border rounded-sm ${config.className}`}
    >
      <div className={`w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_#b1cad7]`} />
      <span className="text-xs font-bold uppercase tracking-tighter">{config.label}</span>
    </div>
  );
}

function PriorityDot({ priority }: { priority: TaskPriority }) {
  const config = PRIORITY_CONFIG[priority];
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${config.dotClass}`} />
      <span className="text-sm font-medium text-on-surface">{config.label}</span>
    </div>
  );
}

function mapTaskEventToActivityEvent(event: TaskEvent, agents: Agent[]): ActivityEvent {
  const actorName = getActorDisplayName(event, agents);
  const statusTransition =
    event.fromStatus && event.toStatus
      ? ` from ${STATUS_DISPLAY[event.fromStatus]?.label ?? event.fromStatus} to ${STATUS_DISPLAY[event.toStatus]?.label ?? event.toStatus}`
      : "";

  const type: ActivityEvent["type"] = (() => {
    switch (event.action) {
      case "claimed":
      case "delegated":
        return "assignment";
      case "created":
        return "creation";
      case "dependency_resolved":
        return "dependency_added";
      case "completed":
      case "approved":
        return "subtask_completed";
      default:
        return "status_change";
    }
  })();

  return {
    id: event.id,
    type,
    description: `${event.action.replace(/_/g, " ")}${statusTransition}`,
    userId: event.actorId,
    userName: actorName,
    timestamp: new Date(event.timestamp),
    metadata: event.metadata,
  };
}

/** An in-progress metadata edit session: the opening baseline captured when
 * Edit mode was entered, bound to the Task it belongs to. */
interface EditingSession extends MetadataEditOpening {
  taskId: string;
}

export function TaskDetailModal() {
  const isSessionActive = useSessionLiveness();
  const {
    isOpen,
    selectedTaskId,
    requestSeq,
    pending,
    switchIntent,
    draftStatus,
    closeModal,
    requestClose,
    resolveRequest,
    acknowledgeSwitch,
  } = useModalStore();
  const { data: agentsData } = useAgents();
  const agents = agentsData ?? [];
  const [visible, setVisible] = React.useState(false);
  const [editing, setEditing] = React.useState<EditingSession | null>(null);
  // Delayed-close fence state: the 200 ms fade timer carries the request
  // generation it was scheduled for; a replacement, reopen, retirement, or
  // unmount inside the delay must not let it close the newer presentation.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef<number | undefined>(requestSeq);

  const { data: taskDetails, isLoading: detailsLoading } = useTaskDetails(
    isOpen ? (selectedTaskId ?? undefined) : undefined,
  );

  const { data: missionData } = useMissionTasks(taskDetails?.mission?.id);
  const missionTasks = missionData?.tasks ?? [];

  const task = taskDetails?.task ?? null;
  const subtasks = taskDetails?.subtasks ?? [];
  const events = taskDetails?.events ?? [];
  const dependencies = taskDetails?.dependencies ?? [];
  const blockedBy = taskDetails?.blockedBy ?? [];
  const blocking = taskDetails?.blocking ?? [];
  const crossHabitatDependsOn = taskDetails?.crossHabitatDependsOn ?? [];

  const dirty = draftStatus?.dirty === true;
  const confirming = !!pending || !!switchIntent;
  const canEditMetadata =
    taskDetails?.canEditMetadata === true && !!taskDetails?.metadataEditIdentity;

  useEffect(() => {
    seqRef.current = requestSeq;
  }, [requestSeq]);

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  const scheduleClose = useCallback(() => {
    setVisible(false);
    const seq = seqRef.current;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!isSessionActive()) return;
      if (seqRef.current !== seq) return; // fenced against a newer presentation
      closeModal();
    }, 200);
  }, [closeModal, isSessionActive]);

  // Ordinary internal closes (Escape, backdrop, header Close) confirm through
  // the store's acknowledged request while a draft is dirty; a clean modal
  // takes the fenced fade path. Saves in flight are settled false by the store.
  const handleClose = useCallback(() => {
    if (confirming) return; // already acknowledging one intent
    if (dirty && requestClose) {
      void requestClose();
      return;
    }
    scheduleClose();
  }, [confirming, dirty, requestClose, scheduleClose]);

  // Fade in exactly once per presentation: the closed→open edge and a new
  // generation while open (same-ID reopen, reopen inside the close delay).
  // This is the ONLY fade-in trigger: no presentation edge (openModal /
  // acknowledgeSwitch) fires during the 200 ms scheduled fade-out, and the one
  // mid-delay generation advance that can — a close request on a draft dirtied
  // after the fade started — intentionally re-fades to present the
  // confirmation over visible content.
  useEffect(() => {
    if (isOpen) requestAnimationFrame(() => setVisible(true));
  }, [requestSeq, isOpen]);

  // The edit session belongs to the presented Task; a close or an acknowledged
  // switch discards it.
  useEffect(() => {
    setEditing(null);
  }, [selectedTaskId]);
  useEffect(() => {
    if (!isOpen) {
      setEditing(null);
      setVisible(false);
    }
  }, [isOpen]);

  const keepEditing = () => {
    if (pending) resolveRequest(pending.seq, false);
    else if (switchIntent) acknowledgeSwitch(switchIntent.seq, false);
  };
  const discardDraft = () => {
    // A same-ID switch never changes selectedTaskId, so the reset effects cannot
    // clear the session — Discard must exit edit mode itself.
    setEditing(null);
    if (pending) resolveRequest(pending.seq, true);
    else if (switchIntent) acknowledgeSwitch(switchIntent.seq, true);
  };

  const startEditing = () => {
    if (!taskDetails?.task || !taskDetails.metadataEditIdentity) return;
    setEditing({
      taskId: taskDetails.task.id,
      identity: taskDetails.metadataEditIdentity,
      version: taskDetails.task.version,
      title: taskDetails.task.title,
      description: taskDetails.task.description ?? "",
      priority: taskDetails.task.priority,
      missionId: taskDetails.task.missionId,
    });
  };

  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const overlayClasses = visible ? "opacity-100" : "opacity-0";
  const modalClasses = visible ? "opacity-100 scale-100" : "opacity-0 scale-95";

  const assigneeName = task ? getAgentDisplayName(task.assignedAgentId, agents) : "Unassigned";

  const missionTitle = taskDetails?.mission?.title ?? "";
  const activityEvents = events.map((event) => mapTaskEventToActivityEvent(event, agents));

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-surface-container-lowest/80 p-4 transition-opacity duration-200 ${overlayClasses}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={task?.title ?? "Task detail"}
    >
      <div
        className={`glass-modal relative w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col transition-all duration-200 ${modalClasses}`}
      >
        {detailsLoading && (
          <div className="flex items-center justify-center py-32">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {!detailsLoading && task && (
          <>
            <div className="relative p-10 pb-4 flex justify-between items-start">
              <div className="space-y-2 min-w-0 flex-1">
                {missionTitle && (
                  <div className="flex items-center gap-2 text-primary text-xs font-label uppercase tracking-widest opacity-80">
                    <span>{missionTitle}</span>
                  </div>
                )}
                <h1 className="text-3xl font-headline font-bold text-on-surface tracking-tight break-words">
                  {task.title}
                </h1>
              </div>
              <button
                onClick={handleClose}
                className="text-on-surface-variant hover:text-on-surface transition-colors p-2 ml-4 flex-shrink-0"
                aria-label="Close modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {editing && editing.taskId === task.id ? (
              <TaskMetadataEditor
                key={`${editing.taskId}:${editing.identity}`}
                taskId={editing.taskId}
                opening={editing}
                presentedKey={queryKeys.tasks.details(selectedTaskId ?? editing.taskId)}
                onDone={() => setEditing(null)}
                onCancel={() => setEditing(null)}
              />
            ) : (
            <>
            <div className="relative px-10 py-5 flex flex-wrap gap-10 bg-surface-container-low/30 border-y border-outline-variant/10">
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                  Assignee
                </span>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-surface-container-high border border-outline-variant/30 flex items-center justify-center">
                    <User className="h-3.5 w-3.5 text-on-surface-variant" />
                  </div>
                  <span className="text-sm font-medium text-on-surface">{assigneeName}</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                  Priority
                </span>
                <PriorityDot priority={task.priority} />
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                  Status
                </span>
                <StatusBadge status={task.status} />
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                  Due Date
                </span>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium text-on-surface">Not set</span>
                </div>
              </div>
            </div>

            <div className="relative flex-1 grid grid-cols-12 overflow-hidden">
              <div
                className="col-span-7 max-md:col-span-12 p-6 md:p-10"
                data-testid="task-detail-left-column"
              >
                <CustomScrollbar className="max-h-[calc(90vh-340px)] pr-1">
                  <div className="space-y-8 max-w-2xl">
                    <div className="space-y-4">
                      <h3 className="text-xs font-label uppercase tracking-widest text-on-surface-variant">
                        Description
                      </h3>
                      {task.description ? (
                        <MarkdownContent
                          content={task.description}
                          className="text-on-surface/90 leading-relaxed font-light text-base"
                        />
                      ) : (
                        <p className="text-sm text-on-surface-variant">No description provided.</p>
                      )}
                    </div>

                    <TaskArtifacts artifacts={task.artifacts} />

                    <div className="space-y-4">
                      <h3 className="text-xs font-label uppercase tracking-widest text-on-surface-variant flex items-center gap-2">
                        <CheckSquare className="h-3.5 w-3.5" />
                        Subtasks ({subtasks.filter((s) => s.completed).length}/{subtasks.length})
                      </h3>
                      {subtasks.length > 0 ? (
                        <div className="space-y-1">
                          {subtasks.map((subtask) => (
                            <div key={subtask.id} className="flex items-center gap-2 py-1.5">
                              <div
                                className={`w-4 h-4 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                                  subtask.completed
                                    ? "bg-primary-container border-primary-container"
                                    : "border-outline-variant/40"
                                }`}
                              >
                                {subtask.completed && (
                                  <svg
                                    className="w-3 h-3 text-primary"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={3}
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      d="M5 13l4 4L19 7"
                                    />
                                  </svg>
                                )}
                              </div>
                              <span
                                className={`text-sm ${subtask.completed ? "line-through text-on-surface-variant" : "text-on-surface"}`}
                              >
                                {subtask.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-on-surface-variant">No subtasks yet.</p>
                      )}
                    </div>

                    <TaskDependencies
                      task={{ dependsOn: dependencies.map((d) => d.id) }}
                      taskId={task.id}
                      dependencies={dependencies}
                      crossHabitatDependsOn={crossHabitatDependsOn}
                      blockedBy={blockedBy}
                      blocking={blocking}
                      boardTasks={missionTasks.map((t) => ({
                        id: t.id,
                        title: t.title,
                        status: t.status,
                      }))}
                      onSelectTask={() => {}}
                      onAddDependency={async () => {}}
                      onRemoveDependency={async () => {}}
                      addingDep={false}
                    />
                  </div>
                </CustomScrollbar>
              </div>

              <div
                className="col-span-5 max-md:col-span-12 bg-surface-container-low/20 border-t md:border-t-0 md:border-l border-outline-variant/10 p-6 md:p-10"
                data-testid="task-detail-right-column"
              >
                <CustomScrollbar className="max-h-[calc(90vh-340px)] pr-1">
                  <div className="space-y-8">
                    <section className="space-y-4">
                      <h3 className="text-xs font-label uppercase tracking-widest text-on-surface-variant">
                        Activity Feed
                      </h3>
                      <TaskActivityFeed events={activityEvents} />
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-xs font-label uppercase tracking-widest text-on-surface-variant">
                        Metadata
                      </h3>
                      <div className="space-y-4 rounded-sm bg-surface-container-high/40 p-4">
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-on-surface-variant">Priority</span>
                          <PriorityDot priority={task.priority} />
                        </div>
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-on-surface-variant">Status</span>
                          <StatusBadge status={task.status} />
                        </div>
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-on-surface-variant">Assignee</span>
                          <span className="text-sm text-on-surface text-right">{assigneeName}</span>
                        </div>
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-on-surface-variant">Due Date</span>
                          <span className="text-sm text-on-surface text-right">Not set</span>
                        </div>
                        {task.estimatedMinutes && (
                          <div className="flex justify-between items-center gap-4">
                            <span className="text-xs text-on-surface-variant">Estimated</span>
                            <span className="text-sm text-on-surface">
                              {task.estimatedMinutes}m
                            </span>
                          </div>
                        )}
                        {task.actualMinutes != null && (
                          <div className="flex justify-between items-center gap-4">
                            <span className="text-xs text-on-surface-variant">Actual</span>
                            <span className="text-sm text-on-surface">{task.actualMinutes}m</span>
                          </div>
                        )}
                        {task.rejectedCount > 0 && (
                          <div className="flex justify-between items-center gap-4">
                            <span className="text-xs text-on-surface-variant">Rejections</span>
                            <span className="text-sm text-error">{task.rejectedCount}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-on-surface-variant">Version</span>
                          <span className="text-sm text-on-surface">v{task.version}</span>
                        </div>
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-on-surface-variant">Updated</span>
                          <span className="text-sm text-on-surface text-right">
                            {formatTimestamp(task.updatedAt)}
                          </span>
                        </div>
                      </div>

                      {task.result && (
                        <div className="p-4 bg-surface-container-high/80 rounded-sm">
                          <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                            Result
                          </span>
                          <p className="mt-1 text-sm text-on-surface/90 whitespace-pre-wrap">
                            {task.result}
                          </p>
                        </div>
                      )}

                      {task.requiredCapabilities.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-xs text-on-surface-variant">Capabilities</span>
                          <div className="flex flex-wrap gap-1">
                            {task.requiredCapabilities.map((cap) => (
                              <span key={cap} className="glass-badge px-2 py-0.5 text-[10px]">
                                {cap}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                </CustomScrollbar>
              </div>
            </div>

            <div className="relative p-6 md:p-8 bg-surface-container-high/50 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-t border-outline-variant/10">
              <div className="flex items-center gap-3">
                <button
                  className="flex items-center gap-2 px-4 py-2 text-on-surface-variant hover:text-on-surface transition-colors text-sm font-medium"
                  type="button"
                >
                  <Share2 className="h-4 w-4" />
                  <span>Share</span>
                </button>
                <button
                  className="flex items-center gap-2 px-4 py-2 text-on-surface-variant hover:text-on-surface transition-colors text-sm font-medium"
                  type="button"
                >
                  <Archive className="h-4 w-4" />
                  <span>Archive</span>
                </button>
              </div>
              <div className="flex items-center gap-3 sm:justify-end">
                {canEditMetadata && (
                  <button
                    type="button"
                    onClick={startEditing}
                    className="px-6 py-3 text-sm font-bold text-on-surface hover:bg-surface-variant/50 transition-all rounded-sm border border-outline-variant/20"
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-6 py-3 text-sm font-bold text-on-surface hover:bg-surface-variant/50 transition-all rounded-sm border border-outline-variant/20"
                >
                  Close
                </button>
              </div>
            </div>
            </>
            )}
          </>
        )}

        {!detailsLoading && !task && selectedTaskId && (
          <div className="flex items-center justify-center py-32">
            <div className="text-center space-y-2">
              <p className="text-on-surface-variant">Failed to load task</p>
              <button onClick={handleClose} className="text-primary text-sm hover:underline">
                Close
              </button>
            </div>
          </div>
        )}

        {confirming && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-surface-container-lowest/80 p-4">
            <div
              className="glass-modal relative w-full max-w-md p-6 space-y-4"
              role="alertdialog"
              aria-modal="true"
              aria-label="Unsaved changes"
            >
              <h2 className="text-lg font-headline font-bold text-on-surface">Unsaved changes</h2>
              <p className="text-sm text-on-surface-variant">
                {switchIntent
                  ? "Discard the unsaved edits and open the new Task?"
                  : "Discard the unsaved edits and close?"}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={keepEditing}
                  className="px-4 py-2 text-sm font-bold text-on-surface hover:bg-surface-variant/50 transition-all rounded-sm border border-outline-variant/20"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={discardDraft}
                  className="px-4 py-2 text-sm font-bold bg-primary-container text-on-primary-container rounded-sm transition-all"
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
