import React from 'react';
import { useQueries } from '@tanstack/react-query';
import { useBoardStore } from '../../store/habitatStore.js';
import { api } from '../../api/index.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { formatRelativeTime } from './MissionHeader.js';
import { Bot, CheckCircle } from 'lucide-react';
import type { Task, TaskComment } from '../../types/index.js';

interface AgentReasoningTraceProps {
  tasks: Task[];
}

interface AgentComment {
  comment: TaskComment;
  task: Task;
  agentName: string;
}

export function AgentReasoningTrace({ tasks }: AgentReasoningTraceProps) {
  const agents = useBoardStore((s) => s.agents);

  const taskIds = React.useMemo(
    () => tasks.map((t) => t.id),
    [tasks]
  );

  const commentResults = useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: queryKeys.comments.list(taskId),
      queryFn: () => api.comments.list(taskId, { limit: 50 }),
      staleTime: 60_000,
    })),
  });

  const agentComments: AgentComment[] = React.useMemo(() => {
    const comments: AgentComment[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const result = commentResults[i];
      if (result?.data?.comments) {
        for (const comment of result.data.comments) {
          if (comment.authorType === 'agent') {
            const agent = agents.find((a) => a.id === comment.authorId);
            comments.push({
              comment,
              task: tasks[i],
              agentName: agent?.name ?? comment.authorId.slice(0, 8),
            });
          }
        }
      }
    }
    return comments.sort(
      (a, b) =>
        new Date(b.comment.createdAt).getTime() -
        new Date(a.comment.createdAt).getTime()
    );
  }, [tasks, commentResults, agents]);

  const isLoading = commentResults.some((r) => r.isLoading);

  return (
    <div className="space-y-4">
      <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest">
        Agent Reasoning Trace
      </h4>
      <div className="glass-panel ghost-border overflow-hidden">
        <div className="max-h-80 overflow-y-auto">
          {isLoading ? (
            <div className="p-4">
              <div className="animate-pulse space-y-4">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="h-16 bg-[var(--surface-container-high)] rounded" />
                ))}
              </div>
            </div>
          ) : agentComments.length === 0 ? (
            <div className="p-6 text-center">
              <Bot className="h-8 w-8 text-[var(--outline-variant)] mx-auto mb-2" />
              <p className="text-[11px] text-[var(--on-surface-variant)]">
                No agent reasoning yet
              </p>
            </div>
          ) : (
            <div className="p-4 relative pl-6 border-l border-[var(--outline-variant)] space-y-6">
              {agentComments.map(({ comment, task, agentName }) => (
                <div key={comment.id} className="relative">
                  <div className="absolute -left-[27px] top-0 w-3 h-3 rounded-full bg-[var(--primary-container)] ring-4 ring-[var(--surface)]" />
                  <div className="bg-[var(--surface-container)] p-3 rounded-lg ghost-border">
                    <div className="flex items-center space-x-2 mb-2">
                      <span className="text-[10px] font-bold text-[var(--on-surface)]">
                        {agentName}
                      </span>
                      <span className="text-[9px] text-[var(--on-surface-variant)] uppercase">
                        {formatRelativeTime(comment.createdAt)}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--on-surface-variant)] leading-normal">
                      {comment.content}
                    </p>
                    <div className="mt-2 flex items-center gap-1 text-[9px] text-[var(--on-surface-variant)]">
                      <span className="font-medium">Task:</span>
                      <span className="truncate">{task.title}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
