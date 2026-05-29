import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  BookOpen,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  ArrowUpRight,
  AlertTriangle,
  Lightbulb,
  Brain,
  GraduationCap,
  MessageSquare,
} from "lucide-react";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import type { SkillCategory, SkillSignal } from "../../types/index.js";

const CATEGORY_CONFIG: Record<
  SkillCategory,
  { label: string; icon: React.ReactNode; color: string }
> = {
  convention: {
    label: "Convention",
    icon: <GraduationCap className="h-3 w-3" />,
    color: "var(--primary)",
  },
  pattern: { label: "Pattern", icon: <Lightbulb className="h-3 w-3" />, color: "var(--tertiary)" },
  pitfall: { label: "Pitfall", icon: <AlertTriangle className="h-3 w-3" />, color: "var(--error)" },
  domain_knowledge: {
    label: "Domain",
    icon: <Brain className="h-3 w-3" />,
    color: "hsl(280,70%,60%)",
  },
  agent_insight: {
    label: "Insight",
    icon: <Sparkles className="h-3 w-3" />,
    color: "hsl(200,70%,60%)",
  },
};

interface SkillPanelProps {
  habitatId: string;
}

export function SkillPanel({ habitatId }: SkillPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<"document" | "signals">("document");
  const queryClient = useQueryClient();

  const { data: skillData, isLoading: skillLoading } = useQuery({
    queryKey: queryKeys.skill.detail(habitatId),
    queryFn: () => api.skill.get(habitatId),
    staleTime: 60 * 1000,
  });

  const { data: signalsData, isLoading: signalsLoading } = useQuery({
    queryKey: queryKeys.skill.signals(habitatId),
    queryFn: () => api.skill.signals(habitatId, { limit: 50 }),
    staleTime: 30 * 1000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.skill.refresh(habitatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skill.detail(habitatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.skill.signals(habitatId) });
    },
  });

  const skill = skillData?.skill;
  const signals = signalsData?.signals ?? [];
  const promotedCount = signals.filter((s) => s.promotedToSkill).length;
  const signalTotal = signalsData?.total ?? 0;

  const strengthBar = (strength: number) => {
    const pct = Math.round(strength * 100);
    const color =
      strength >= 0.6 ? "var(--tertiary)" : strength >= 0.3 ? "hsl(40,90%,55%)" : "var(--error)";
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-1 w-12 rounded-full bg-[var(--surface-container-highest)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-[9px] text-[var(--on-surface-variant)] tabular-nums">{pct}%</span>
      </div>
    );
  };

  return (
    <div className="glass-panel rounded-lg border border-[var(--outline-variant)] overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-container)]/60 hover:bg-[var(--surface-container)] transition-colors cursor-pointer select-none"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-[var(--on-surface-variant)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--on-surface-variant)]" />
        )}
        <BookOpen className="h-4 w-4 text-[var(--primary)]" />
        <span className="text-xs font-semibold text-[var(--on-surface)] uppercase tracking-wider">
          Skill
        </span>
        {skill && (
          <span className="text-[10px] text-[var(--on-surface-variant)] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
            {skill.signalCount} signal{skill.signalCount !== 1 ? "s" : ""}
          </span>
        )}
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto">
          {promotedCount} promoted
        </span>
        {!collapsed && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              refreshMutation.mutate();
            }}
            disabled={refreshMutation.isPending}
            className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-semibold text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
            Refresh
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          <div className="flex border-b border-[var(--outline-variant)]">
            <button
              type="button"
              onClick={() => setTab("document")}
              className={`flex-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                tab === "document"
                  ? "text-[var(--primary)] border-b-2 border-[var(--primary)] bg-[var(--surface-container)]/40"
                  : "text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]"
              }`}
            >
              Document
            </button>
            <button
              type="button"
              onClick={() => setTab("signals")}
              className={`flex-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                tab === "signals"
                  ? "text-[var(--primary)] border-b-2 border-[var(--primary)] bg-[var(--surface-container)]/40"
                  : "text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]"
              }`}
            >
              Signals
              {signalTotal > 0 && (
                <span className="ml-1 text-[9px] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded-full">
                  {signalTotal}
                </span>
              )}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto p-3">
            {tab === "document" ? (
              skillLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
                </div>
              ) : !skill?.content ? (
                <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
                  <BookOpen className="h-6 w-6 opacity-30" />
                  <span className="text-xs">
                    No skill document yet. Signals will accumulate as agents work.
                  </span>
                  <button
                    type="button"
                    onClick={() => refreshMutation.mutate()}
                    disabled={refreshMutation.isPending}
                    className="mt-1 text-[10px] text-[var(--primary)] hover:underline disabled:opacity-50"
                  >
                    Generate from signals
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-[10px] text-[var(--on-surface-variant)]">
                    <span>Avg strength: {Math.round((skill.avgStrength ?? 0) * 100)}%</span>
                    <span className="opacity-40">|</span>
                    <span>Generated: {skill.generationCount}x</span>
                    {skill.lastGeneratedAt && (
                      <>
                        <span className="opacity-40">|</span>
                        <span>{new Date(skill.lastGeneratedAt).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                  <div className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/40 p-3">
                    <MarkdownContent content={skill.content} />
                  </div>
                </div>
              )
            ) : signalsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
              </div>
            ) : signals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
                <MessageSquare className="h-6 w-6 opacity-30" />
                <span className="text-xs">No signals accumulated yet</span>
              </div>
            ) : (
              <div className="space-y-2">
                {signals.map((signal) => (
                  <SignalRow
                    key={signal.id}
                    signal={signal}
                    habitatId={habitatId}
                    strengthBar={strengthBar}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SignalRow({
  signal,
  habitatId,
  strengthBar,
}: {
  signal: SkillSignal;
  habitatId: string;
  strengthBar: (s: number) => React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const cat = CATEGORY_CONFIG[signal.skillCategory] ?? CATEGORY_CONFIG.agent_insight;

  const deleteMutation = useMutation({
    mutationFn: () => api.skill.deleteSignal(habitatId, signal.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skill.signals(habitatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.skill.detail(habitatId) });
    },
  });

  return (
    <div
      className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/60 p-3 space-y-1.5 transition-colors hover:bg-[var(--surface-container)] group"
      style={{ borderLeftWidth: "3px", borderLeftColor: cat.color }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{
            backgroundColor: `color-mix(in srgb, ${cat.color} 15%, transparent)`,
            color: cat.color,
          }}
        >
          {cat.icon}
          {cat.label}
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
          {signal.sourceType}
        </span>
        {signal.promotedToSkill && (
          <span className="inline-flex items-center gap-0.5 text-[9px] text-[var(--tertiary)]">
            <ArrowUpRight className="h-3 w-3" />
            promoted
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {strengthBar(signal.strength)}
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--on-surface-variant)] hover:text-[var(--error)] hover:bg-[var(--surface-container-high)] transition-all disabled:opacity-50"
            title="Delete signal"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <p className="text-sm font-semibold text-[var(--on-surface)] leading-snug">
        {signal.subject}
      </p>
      {signal.summary && (
        <p className="text-xs text-[var(--on-surface-variant)] line-clamp-2">{signal.summary}</p>
      )}

      <div className="flex items-center gap-3 text-[9px] text-[var(--on-surface-variant)] pt-0.5">
        <span>freq: {signal.frequency}</span>
        <span>agents: {signal.corroboratingAgents}</span>
        {signal.crossMissionCount > 0 && <span>cross: {signal.crossMissionCount}</span>}
        {signal.failedTasks > 0 && (
          <span className="text-[var(--error)]">failed: {signal.failedTasks}</span>
        )}
      </div>
    </div>
  );
}
