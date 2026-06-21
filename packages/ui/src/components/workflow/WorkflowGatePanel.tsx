import React from "react";
import { Button } from "../ui/Button.js";
import { GATE_TYPE_LABELS } from "./workflowEditorUtils.js";

/** A task summary displayed in the gate panel with clickable navigation. */
interface GatePanelTask {
  id: string;
  title: string;
  status: string;
}

/** Props for the {@link WorkflowGatePanel} component. */
interface WorkflowGatePanelProps {
  gate: {
    id: string;
    gateType: string;
    satisfied: boolean;
    satisfiedAt: string | null;
    satisfiedByEventId: string | null;
    upstreamTaskId: string;
    downstreamTaskId: string;
    recoveryTaskId: string | null;
    recoveryDepth: number | null;
  };
  upstreamTask: GatePanelTask | undefined;
  downstreamTask: GatePanelTask | undefined;
  isAdmin: boolean;
  unblocking: boolean;
  onUnblock: () => void;
  onClose: () => void;
  onNavigateTask: (taskId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "text-muted-foreground",
  claimed: "text-blue-500",
  in_progress: "text-blue-500",
  submitted: "text-yellow-600",
  approved: "text-green-600",
  done: "text-green-600",
  failed: "text-red-500",
  rejected: "text-red-500",
};

/** Side panel showing gate details, state, and admin-only manual unblock for `on_manual` gates. */
export function WorkflowGatePanel({
  gate,
  upstreamTask,
  downstreamTask,
  isAdmin,
  unblocking,
  onUnblock,
  onClose,
  onNavigateTask,
}: WorkflowGatePanelProps) {
  const stateLabel = gate.satisfied
    ? "Satisfied"
    : gate.recoveryTaskId
      ? "Recovery Spawned"
      : "Waiting";
  const stateColor = gate.satisfied
    ? "text-green-600"
    : gate.recoveryTaskId
      ? "text-yellow-600"
      : "text-muted-foreground";

  const isManualGate = gate.gateType === "on_manual";
  const canUnblock = isAdmin && isManualGate && !gate.satisfied;

  return (
    <div
      data-testid="workflow-gate-panel"
      className="fixed inset-y-0 right-0 w-80 bg-background border-l border-border p-4 overflow-y-auto shadow-lg"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Gate Detail</h3>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="gate-panel-close">
          ✕
        </Button>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <span className="text-muted-foreground">Type: </span>
          <span className="font-medium">
            {GATE_TYPE_LABELS[gate.gateType as keyof typeof GATE_TYPE_LABELS] ?? gate.gateType}
          </span>
        </div>

        <div>
          <span className="text-muted-foreground">State: </span>
          <span className={`font-medium ${stateColor}`} data-testid="gate-state">
            {stateLabel}
          </span>
        </div>

        {gate.satisfied && gate.satisfiedAt && (
          <div>
            <span className="text-muted-foreground">Satisfied at: </span>
            <span className="font-mono text-xs">{new Date(gate.satisfiedAt).toLocaleString()}</span>
          </div>
        )}

        {gate.satisfied && gate.satisfiedByEventId && (
          <div>
            <span className="text-muted-foreground">Event: </span>
            <span className="font-mono text-xs">{gate.satisfiedByEventId}</span>
          </div>
        )}

        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">Upstream Task</p>
          {upstreamTask ? (
            <button
              onClick={() => onNavigateTask(upstreamTask.id)}
              className="text-left hover:underline"
              data-testid="gate-upstream-task"
            >
              <span className="font-medium">{upstreamTask.title}</span>
              <span className={`ml-2 text-xs ${STATUS_COLORS[upstreamTask.status] ?? ""}`}>
                {upstreamTask.status}
              </span>
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">{gate.upstreamTaskId}</span>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">Downstream Task</p>
          {downstreamTask ? (
            <button
              onClick={() => onNavigateTask(downstreamTask.id)}
              className="text-left hover:underline"
              data-testid="gate-downstream-task"
            >
              <span className="font-medium">{downstreamTask.title}</span>
              <span className={`ml-2 text-xs ${STATUS_COLORS[downstreamTask.status] ?? ""}`}>
                {downstreamTask.status}
              </span>
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">{gate.downstreamTaskId}</span>
          )}
        </div>

        {gate.recoveryTaskId && (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground mb-1">Recovery</p>
            <button
              onClick={() => onNavigateTask(gate.recoveryTaskId!)}
              className="text-left hover:underline"
              data-testid="gate-recovery-task"
            >
              <span className="font-medium text-yellow-600">
                Recovery task (depth {gate.recoveryDepth ?? 1})
              </span>
            </button>
          </div>
        )}
      </div>

      {canUnblock && (
        <div className="mt-4 border-t border-border pt-3">
          <Button onClick={onUnblock} loading={unblocking} data-testid="gate-unblock-btn">
            Manual Unblock
          </Button>
        </div>
      )}

      {isManualGate && gate.satisfied && (
        <p className="mt-4 text-xs text-muted-foreground">Gate already satisfied.</p>
      )}

      {!isAdmin && isManualGate && !gate.satisfied && (
        <p className="mt-4 text-xs text-muted-foreground">
          Admin access required to manually unblock gates.
        </p>
      )}
    </div>
  );
}
