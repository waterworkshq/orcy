import React from 'react';
import { ShieldCheck, CheckCircle2, Circle, Link2 } from 'lucide-react';
import type { TaskQualityReport, QualityChecklist } from '../../types/index.js';
import { QUALITY_STATUS_BADGE } from '../../lib/status-maps.js';

interface TaskQualityChecklistProps {
  taskId: string;
  report: TaskQualityReport | null;
  loading: boolean;
  onToggleItem: (checklistId: string, itemId: string, isCompleted: boolean) => Promise<void>;
}

function ChecklistProgress({ checklist }: { checklist: QualityChecklist }) {
  const { completed, total } = checklist.progress;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="mb-1">
      <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={`h-1.5 rounded-full transition-all ${pct >= 100 ? 'bg-[var(--badge-done)]' : 'bg-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function TaskQualityChecklist({
  taskId: _taskId,
  report,
  loading,
  onToggleItem,
}: TaskQualityChecklistProps) {
  if (loading) {
    return (
      <div className="mb-4">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
          <ShieldCheck className="h-3 w-3" />
          Breach Gates
        </h4>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading...
        </div>
      </div>
    );
  }

  if (!report || report.checklists.length === 0) {
    return (
      <div className="mb-4">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
          <ShieldCheck className="h-3 w-3" />
          Breach Gates
        </h4>
        <p className="text-sm text-muted-foreground">No breach gates configured</p>
      </div>
    );
  }

  const statusLabel = report.overallStatus === 'passed' ? 'Passed' : 'Blocked';

  return (
    <div className="mb-4">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        <ShieldCheck className="h-3 w-3" />
        Quality Gates
        <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${QUALITY_STATUS_BADGE[report.overallStatus]}`}>
          {statusLabel}
        </span>
      </h4>

      <div className="space-y-3">
        {report.checklists.map((checklist) => (
          <div key={checklist.id} className="rounded border bg-card p-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium">{checklist.templateName}</span>
              {checklist.category && (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                  {checklist.category}
                </span>
              )}
              {checklist.required ? (
                <span className="text-[10px] font-medium text-red-600 dark:text-red-400">Required</span>
              ) : (
                <span className="text-[10px] text-muted-foreground">Optional</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {checklist.progress.completed}/{checklist.progress.total}
              </span>
            </div>

            <ChecklistProgress checklist={checklist} />

            <div className="mt-1.5 space-y-1">
              {checklist.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded p-1 hover:bg-accent"
                >
                  <button
                    onClick={() => onToggleItem(checklist.id, item.id, !item.isCompleted)}
                    className="mt-0.5 flex-shrink-0"
                  >
                    {item.isCompleted ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <span
                      className={`text-sm ${
                        item.isCompleted
                          ? 'text-green-700 line-through dark:text-green-300'
                          : ''
                      }`}
                    >
                      {item.title}
                    </span>
                    {item.required && !item.isCompleted && (
                      <span className="ml-1.5 text-[10px] text-red-500 dark:text-red-400">
                        Required
                      </span>
                    )}
                    {item.evidenceUrl && (
                      <a
                        href={item.evidenceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-blue-600 hover:underline dark:text-blue-400"
                      >
                        <Link2 className="h-3 w-3" />
                        evidence
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
