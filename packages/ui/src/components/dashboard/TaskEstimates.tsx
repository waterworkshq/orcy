import React from "react";
import type { TaskEstimate } from "../../types/index.js";
import { PRIORITY_BADGE } from "../../lib/status-maps.js";

interface TaskEstimatesProps {
  estimates: TaskEstimate[];
}

const confidenceColors: Record<string, string> = {
  high: "text-green-600 dark:text-green-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-destructive",
  insufficient_data: "text-muted-foreground",
};

export function TaskEstimates({ estimates }: TaskEstimatesProps) {
  if (estimates.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        No open tasks to estimate
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Task</th>
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Priority</th>
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Status</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Est. Days</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Due</th>
            <th className="text-center py-2 px-3 font-medium text-muted-foreground">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {estimates.map((est) => (
            <tr key={est.taskId} className="border-b border-border/50">
              <td className="py-2 px-3 max-w-[200px] truncate font-medium text-foreground">
                {est.taskTitle}
              </td>
              <td className="py-2 px-3">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_BADGE[est.priority] ?? ""}`}
                >
                  {est.priority}
                </span>
              </td>
              <td className="py-2 px-3 text-muted-foreground">{est.status.replaceAll("_", " ")}</td>
              <td className="py-2 px-3 text-right font-mono text-foreground/70">
                {est.daysUntilEstimated !== null ? `${est.daysUntilEstimated}d` : "-"}
              </td>
              <td className="py-2 px-3 text-right">
                {est.daysUntilDue !== null ? (
                  <span
                    className={
                      est.daysUntilDue < 0
                        ? "text-destructive font-medium"
                        : est.daysUntilDue < 2
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                    }
                  >
                    {est.daysUntilDue < 0
                      ? `${Math.abs(Math.round(est.daysUntilDue))}d overdue`
                      : `${Math.round(est.daysUntilDue)}d`}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              <td className="py-2 px-3 text-center">
                <span className={`text-xs font-medium ${confidenceColors[est.confidence] ?? ""}`}>
                  {est.confidence}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
