import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/index.js';
import { queryKeys } from '../lib/queryKeys.js';
import { Button } from '../components/ui/Button.js';
import {
  ArrowLeft,
  AlertCircle,
  Radio,
  Activity,
  ListTodo,
  MessageSquare,
} from 'lucide-react';
import {
  FeatureHeader,
  formatStatus,
  formatRelativeTime,
} from '../components/habitat/MissionHeader.js';
import { FeatureMetrics } from '../components/habitat/MissionMetrics.js';
import { FeatureTaskKanban } from '../components/habitat/MissionTaskKanban.js';
import { PipelineContextSidebar } from '../components/habitat/PipelineContextSidebar.js';
import { RiskAnalysisSidebar } from '../components/habitat/RiskAnalysisSidebar.js';
import { CodeReviewSection } from '../components/habitat/CodeReviewSection.js';
import { AgentReasoningTrace } from '../components/habitat/AgentReasoningTrace.js';
import { CommentInputBar } from '../components/habitat/CommentInputBar.js';
import { MissionCommentSection } from '../components/habitat/MissionCommentSection.js';
import { PulseBoard } from '../components/habitat/PulseBoard.js';
import type {
  Task,
  MissionWithProgress,
  MissionEvent,
} from '../types/index.js';


function FeatureActivity({
  events,
}: {
  events: MissionEvent[];
}) {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase tracking-widest">
        Activity
      </h4>
      <div className="relative pl-6 border-l border-[var(--outline-variant)] space-y-4">
        {events.slice(0, 20).map((event) => (
          <div key={event.id} className="relative">
            <div className="absolute -left-[27px] top-0 w-3 h-3 rounded-full bg-[var(--primary-container)] ring-4 ring-[var(--surface)]" />
            <div className="bg-[var(--surface-container)] p-3 rounded-lg border border-[var(--outline-variant)]">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold text-[var(--on-surface)]">
                  {event.actorType === 'system'
                    ? 'System'
                    : event.actorId.slice(0, 8)}
                </span>
                <span className="text-[9px] text-[var(--on-surface-variant)] uppercase">
                  {formatRelativeTime(event.timestamp)}
                </span>
              </div>
              <p className="text-xs text-[var(--on-surface-variant)]">
                {formatStatus(event.action)}
                {event.fromStatus && event.toStatus
                  ? `: ${formatStatus(event.fromStatus)} → ${formatStatus(event.toStatus)}`
                  : ''}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="h-full animate-pulse flex">
      <div className="w-72 bg-[var(--surface-container)]/20 border-r border-[var(--outline-variant)] p-4">
        <div className="h-3 w-24 bg-[var(--surface-container-high)] rounded mb-4" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-[var(--surface-container-high)] rounded" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-6 space-y-6">
        <div className="h-20 bg-[var(--surface-container-high)] rounded" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-[var(--surface-container-high)] rounded" />
          ))}
        </div>
        <div className="h-48 bg-[var(--surface-container-high)] rounded" />
      </div>
      <div className="w-80 bg-[var(--surface-container)]/20 border-l border-[var(--outline-variant)] p-6">
        <div className="h-3 w-24 bg-[var(--surface-container-high)] rounded mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-10 bg-[var(--surface-container-high)] rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorView({
  message,
  onBack,
}: {
  message: string;
  onBack: () => void;
}) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-4">
        <AlertCircle className="h-12 w-12 text-[var(--error)] mx-auto" />
        <h2 className="text-xl font-bold text-[var(--on-surface)]">
          {message}
        </h2>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Habitat
        </Button>
      </div>
    </div>
  );
}

export function MissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<'tasks' | 'pulse' | 'activity' | 'comments'>('tasks');
  const queryClient = useQueryClient();

  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.missions.details(id ?? ''),
    queryFn: () => api.missions.details(id!),
    enabled: !!id,
    staleTime: 30 * 1000,
  });

  const pulseDigest = useQuery({
    queryKey: ['pulse', 'digest', id],
    queryFn: () => api.pulse.digest(id!),
    enabled: !!id && activeTab === 'pulse',
    staleTime: 10 * 1000,
  });

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (error || !data) {
    const isNotFound =
      error?.message?.includes('404') ||
      error?.message?.includes('not found') ||
      error?.message?.includes('Not Found');
    return (
      <ErrorView
        message={isNotFound ? 'Mission not found' : 'Failed to load mission'}
        onBack={() => window.history.back()}
      />
    );
  }

  const { feature, tasks, events, progress, dependencies } = data;

  const tabs = [
    { key: 'tasks' as const, label: 'Tasks', icon: ListTodo },
    { key: 'pulse' as const, label: 'Pulse', icon: Radio },
    { key: 'comments' as const, label: 'Comments', icon: MessageSquare },
    { key: 'activity' as const, label: 'Activity', icon: Activity },
  ];

  return (
    <div className="h-full flex flex-col bg-[var(--surface)]">
      <div className="flex flex-1 min-h-0">
        <PipelineContextSidebar feature={feature} tasks={tasks} />

        <section className="flex-1 flex flex-col min-w-0">
          <FeatureHeader feature={feature} />

          <div className="flex border-b border-[var(--outline-variant)] bg-[var(--surface-container)]/50">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors relative ${
                  activeTab === key
                    ? 'text-[var(--primary)]'
                    : 'text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {activeTab === key && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--primary)]" />
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {activeTab === 'tasks' && (
              <div className="p-6">
                <div className="max-w-4xl mx-auto space-y-6">
                  <FeatureMetrics
                    progress={progress}
                    tasks={tasks}
                    dependencies={dependencies}
                  />

                  <CodeReviewSection tasks={tasks} />

                  <AgentReasoningTrace tasks={tasks} />

                  <FeatureTaskKanban tasks={tasks} />
                </div>
              </div>
            )}

            {activeTab === 'pulse' && id && <PulseBoard missionId={id} />}

            {activeTab === 'comments' && id && (
              <MissionCommentSection missionId={id} />
            )}

            {activeTab === 'activity' && (
              <div className="p-6">
                <div className="max-w-4xl mx-auto">
                  {events.length > 0 ? (
                    <FeatureActivity events={events} />
                  ) : (
                    <div className="flex items-center justify-center h-32 text-[var(--on-surface-variant)] text-sm">
                      No activity yet
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {activeTab === 'tasks' && <CommentInputBar tasks={tasks} />}
        </section>

        <RiskAnalysisSidebar
          feature={feature}
          tasks={tasks}
          events={events}
          dependencies={dependencies}
        />
      </div>
    </div>
  );
}
