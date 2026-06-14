import React from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { formatRelativeTime } from "./MissionHeader.js";
import { Code, FileCode } from "lucide-react";
import type { Task, TaskComment } from "../../types/index.js";

interface CodeReviewSectionProps {
  tasks: Task[];
}

interface TaskReviewGroup {
  task: Task;
  comments: TaskComment[];
}

function CommentItem({ comment }: { comment: TaskComment }) {
  return (
    <div className="py-2 border-b border-[var(--outline-variant)] last:border-b-0">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-5 h-5 rounded-full bg-[var(--surface-container-high)] flex items-center justify-center text-[8px] font-bold text-[var(--on-surface-variant)]">
          {comment.authorType === "agent"
            ? "🤖"
            : comment.authorType === "remote_human" || comment.authorType === "remote_orcy"
              ? "🌐"
              : comment.authorId.slice(0, 2).toUpperCase()}
        </div>
        <span className="text-[10px] font-bold text-[var(--on-surface)]">
          {comment.authorType === "agent"
            ? "Agent"
            : comment.authorType === "remote_human"
              ? "Remote User"
              : comment.authorType === "remote_orcy"
                ? "Remote Or"
                : "Reviewer"}
        </span>
        <span className="text-[9px] text-[var(--on-surface-variant)] uppercase">
          {formatRelativeTime(comment.createdAt)}
        </span>
      </div>
      <p className="text-[11px] text-[var(--on-surface-variant)] leading-relaxed pl-7">
        {comment.content}
      </p>
    </div>
  );
}

export function CodeReviewSection({ tasks }: CodeReviewSectionProps) {
  const taskIds = React.useMemo(() => tasks.map((t) => t.id), [tasks]);

  const commentResults = useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: queryKeys.comments.list(taskId),
      queryFn: () => api.comments.list(taskId, { limit: 50 }),
      staleTime: 60_000,
    })),
  });

  const reviewGroups: TaskReviewGroup[] = React.useMemo(() => {
    const groups: TaskReviewGroup[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const result = commentResults[i];
      if (result?.data?.comments && result.data.comments.length > 0) {
        groups.push({
          task: tasks[i],
          comments: result.data.comments,
        });
      }
    }
    return groups;
  }, [tasks, commentResults]);

  const isLoading = commentResults.some((r) => r.isLoading);

  return (
    <div className="glass-panel ghost-border overflow-hidden">
      <div className="px-4 py-3 bg-[var(--surface-container-high)]/50 ghost-border-b flex justify-between items-center">
        <span className="text-xs font-bold flex items-center text-[var(--on-surface)]">
          <Code className="h-4 w-4 mr-2 text-[var(--on-surface-variant)]" />
          Code Review
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)]">
          {reviewGroups.length} {reviewGroups.length === 1 ? "task" : "tasks"} with reviews
        </span>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center">
            <div className="animate-pulse space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-12 bg-[var(--surface-container-high)] rounded" />
              ))}
            </div>
          </div>
        ) : reviewGroups.length === 0 ? (
          <div className="p-6 text-center">
            <FileCode className="h-8 w-8 text-[var(--outline-variant)] mx-auto mb-2" />
            <p className="text-[11px] text-[var(--on-surface-variant)]">No review comments yet</p>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {reviewGroups.map(({ task, comments }) => (
              <div key={task.id}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-bold text-[var(--on-surface)]">
                    {task.title}
                  </span>
                  <span className="text-[9px] text-[var(--on-surface-variant)]">
                    #{task.id.slice(0, 4)}
                  </span>
                </div>
                <div className="pl-3 border-l border-[var(--outline-variant)]">
                  {comments.map((comment) => (
                    <CommentItem key={comment.id} comment={comment} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
