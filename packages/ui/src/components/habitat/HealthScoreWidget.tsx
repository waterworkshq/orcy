import React, { useState, useEffect } from 'react';
import { api } from '../../api/index.js';
import { Activity, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, Clock, Users, Shield } from 'lucide-react';

interface HealthScoreWidgetProps {
  boardId: string;
}

function getGradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'var(--badge-done)';
    case 'B': return 'var(--agent-blue)';
    case 'C': return 'var(--agent-orange, #f59e0b)';
    case 'D': return 'var(--error)';
    case 'F': return 'var(--error)';
    default: return 'var(--on-surface-variant)';
  }
}

const dimensionIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  flow: Activity,
  quality: CheckCircle,
  delivery: Clock,
  capacity: Users,
  stability: Shield,
};

const dimensionLabels: Record<string, string> = {
  flow: 'Flow',
  quality: 'Quality',
  delivery: 'Delivery',
  capacity: 'Capacity',
  stability: 'Stability',
};

export function HealthScoreWidget({ boardId }: HealthScoreWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const [health, setHealth] = useState<{ score: number; grade: string; dimensions: Record<string, { score: number } & Record<string, number>>; recommendations: string[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!boardId) return;
    if (!api.health) return;
    setLoading(true);
    api.health.get(boardId)
      .then(data => setHealth(data))
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }, [boardId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--outline-variant)] animate-pulse">
        <div className="h-6 w-6 rounded-full bg-[var(--surface-container-high)]" />
        <div className="h-4 w-16 bg-[var(--surface-container-high)] rounded" />
      </div>
    );
  }

  if (!health) return null;

  const gradeColor = getGradeColor(health.grade);

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)] hover:bg-[var(--surface-container-high)] transition-colors"
        title="Board Health Score"
      >
        <div
          className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold text-white"
          style={{ backgroundColor: gradeColor }}
        >
          {health.grade}
        </div>
        <span className="text-xs font-semibold text-[var(--on-surface)]">{health.score}</span>
        {health.score >= 75 ? (
          <TrendingUp className="h-3 w-3 text-[var(--badge-done)]" />
        ) : health.score >= 40 ? (
          <TrendingDown className="h-3 w-3 text-[var(--agent-orange)]" />
        ) : (
          <AlertTriangle className="h-3 w-3 text-[var(--error)]" />
        )}
      </button>

      {expanded && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setExpanded(false)} />
          <div className="absolute top-full right-0 mt-2 w-80 bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-xl shadow-lg z-50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--on-surface)]">Board Health</h3>
              <div
                className="flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold text-white"
                style={{ backgroundColor: gradeColor }}
              >
                {health.grade}
              </div>
            </div>

            <div className="space-y-2">
              {Object.entries(health.dimensions).map(([key, dim]) => {
                const Icon = dimensionIcons[key] || Activity;
                const label = dimensionLabels[key] || key;
                return (
                  <div key={key} className="flex items-center gap-3">
                    <Icon className="h-3.5 w-3.5 text-[var(--on-surface-variant)]" />
                    <span className="text-xs text-[var(--on-surface-variant)] flex-1">{label}</span>
                    <div className="w-20 bg-[var(--surface-container-high)] rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full transition-all"
                        style={{
                          width: `${dim.score}%`,
                          backgroundColor: dim.score >= 90 ? 'var(--badge-done)' : dim.score >= 70 ? 'var(--agent-blue)' : dim.score >= 50 ? 'var(--agent-orange)' : 'var(--error)',
                        }}
                      />
                    </div>
                    <span className="text-[10px] font-semibold text-[var(--on-surface)] w-6 text-right">{dim.score}</span>
                  </div>
                );
              })}
            </div>

            {health.recommendations.length > 0 && (
              <div className="pt-2 border-t border-[var(--outline-variant)]">
                <h4 className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase tracking-wider mb-2">Recommendations</h4>
                <ul className="space-y-1">
                  {health.recommendations.slice(0, 3).map((rec, i) => (
                    <li key={i} className="text-[10px] text-[var(--on-surface-variant)] flex items-start gap-1">
                      <span className="mt-0.5 text-[var(--primary)]">•</span>
                      {rec}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
