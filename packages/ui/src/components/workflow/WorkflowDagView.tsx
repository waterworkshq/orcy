import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dagre from "dagre";
import { Button } from "../ui/Button.js";
import { notify } from "../../lib/toast.js";
import { api } from "../../api/index.js";
import { WorkflowGatePanel } from "./WorkflowGatePanel.js";
import { GATE_TYPE_LABELS } from "./workflowEditorUtils.js";
import type { Task } from "../../types/index.js";

/** Props for the {@link WorkflowDagView} component. */
interface WorkflowDagViewProps {
  missionId: string;
  tasks: Task[];
  isAdmin: boolean;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const NODE_SEP = 40;
const RANK_SEP = 80;

const STATUS_BORDER_COLORS: Record<string, string> = {
  pending: "hsl(var(--border))",
  claimed: "#3b82f6",
  in_progress: "#3b82f6",
  submitted: "#eab308",
  approved: "#22c55e",
  done: "#22c55e",
  failed: "#ef4444",
  rejected: "#ef4444",
};

const STATUS_FILL_COLORS: Record<string, string> = {
  pending: "hsl(var(--card))",
  claimed: "#eff6ff",
  in_progress: "#eff6ff",
  submitted: "#fefce8",
  approved: "#f0fdf4",
  done: "#f0fdf4",
  failed: "#fef2f2",
  rejected: "#fef2f2",
};

type GateVisualState = "satisfied" | "unsatisfied" | "failed";

const EDGE_COLORS: Record<GateVisualState, string> = {
  satisfied: "#22c55e",
  unsatisfied: "hsl(var(--muted-foreground))",
  failed: "#ef4444",
};

/** Renders a live workflow DAG on the mission detail page with color-coded gate states and admin gate controls. */
export function WorkflowDagView({ missionId, tasks, isAdmin }: WorkflowDagViewProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["workflow", "mission", missionId],
    queryFn: () => api.workflows.getForMission(missionId),
    staleTime: 10 * 1000,
  });

  const unblockMutation = useMutation({
    mutationFn: (gateId: string) => {
      if (!data) throw new Error("No workflow loaded");
      return api.workflows.unblockGate(data.workflow.id, gateId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "mission", missionId] });
      notify.success("Gate unblocked");
    },
    onError: (err: Error) => notify.error(err.message),
  });

  const detachMutation = useMutation({
    mutationFn: () => {
      if (!data) throw new Error("No workflow loaded");
      return api.workflows.detach(data.workflow.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "mission", missionId] });
      notify.success("Workflow detached");
    },
    onError: (err: Error) => notify.error(err.message),
  });

  const [confirmDetach, setConfirmDetach] = useState(false);

  const taskMap = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const layout = useMemo(() => {
    if (!data || data.gates.length === 0) return null;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const nodeIds = new Set<string>();
    for (const gate of data.gates) {
      nodeIds.add(gate.upstreamTaskId);
      nodeIds.add(gate.downstreamTaskId);
    }

    for (const id of nodeIds) {
      g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }

    for (const gate of data.gates) {
      g.setEdge(gate.upstreamTaskId, gate.downstreamTaskId, { label: gate.gateType });
    }

    dagre.layout(g);

    const nodes = g.nodes().map((id) => {
      const node = g.node(id);
      const task = taskMap.get(id);
      return {
        id,
        x: node.x,
        y: node.y,
        title: task?.title ?? id.slice(0, 8),
        status: task?.status ?? "pending",
      };
    });

    const edges = data.gates.map((gate) => {
      const edge = g.edge(gate.upstreamTaskId, gate.downstreamTaskId);
      const upstreamTask = taskMap.get(gate.upstreamTaskId);
      let visualState: GateVisualState = "unsatisfied";
      if (gate.satisfied) {
        visualState = "satisfied";
      } else if (
        upstreamTask &&
        (upstreamTask.status === "failed" || upstreamTask.status === "rejected")
      ) {
        visualState = "failed";
      }
      return {
        id: gate.id,
        gate,
        points: edge?.points ?? [],
        label: GATE_TYPE_LABELS[gate.gateType as keyof typeof GATE_TYPE_LABELS] ?? gate.gateType,
        visualState,
      };
    });

    const graph = g.graph();
    return { nodes, edges, width: graph?.width ?? 0, height: graph?.height ?? 0 };
  }, [data, taskMap]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        Loading workflow...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        data-testid="workflow-dag-empty"
        className="flex items-center justify-center rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground"
      >
        No workflow attached to this mission.
      </div>
    );
  }

  const selectedGate = selectedGateId ? data.gates.find((g) => g.id === selectedGateId) : null;
  const selectedUpstreamTask = selectedGate ? taskMap.get(selectedGate.upstreamTaskId) : undefined;
  const selectedDownstreamTask = selectedGate
    ? taskMap.get(selectedGate.downstreamTaskId)
    : undefined;

  return (
    <div data-testid="workflow-dag-view" className="relative">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Workflow DAG
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {data.gates.length} gate{data.gates.length === 1 ? "" : "s"} · status:{" "}
            {data.workflow.status}
          </span>
        </h3>
        {isAdmin && data.workflow.status === "active" && (
          <div>
            {confirmDetach ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Stop enforcing all gates?</span>
                <Button
                  variant="destructive"
                  size="sm"
                  loading={detachMutation.isPending}
                  onClick={() => detachMutation.mutate()}
                  data-testid="detach-confirm"
                >
                  Yes, detach
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDetach(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDetach(true)}
                data-testid="detach-workflow-btn"
              >
                Detach Workflow
              </Button>
            )}
          </div>
        )}
      </div>

      {layout && layout.nodes.length > 0 ? (
        <div className="overflow-auto rounded-md border border-border p-2">
          <svg width={layout.width} height={layout.height} style={{ minWidth: "100%" }}>
            <defs>
              {(["satisfied", "unsatisfied", "failed"] as GateVisualState[]).map((vs) => (
                <marker
                  key={vs}
                  id={`arrowhead-${vs}`}
                  markerWidth="10"
                  markerHeight="7"
                  refX="9"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" fill={EDGE_COLORS[vs]} />
                </marker>
              ))}
            </defs>

            {layout.edges.map((edge) => {
              if (edge.points.length < 2) return null;
              const path = edge.points
                .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
                .join(" ");
              const midIndex = Math.floor(edge.points.length / 2);
              const midPoint = edge.points[midIndex] ?? edge.points[0];
              return (
                <g
                  key={edge.id}
                  onClick={() => setSelectedGateId(edge.id)}
                  className="cursor-pointer"
                  data-testid={`dag-gate-${edge.id}`}
                >
                  <path
                    d={path}
                    fill="none"
                    stroke={EDGE_COLORS[edge.visualState]}
                    strokeWidth={2}
                    strokeDasharray={edge.visualState === "unsatisfied" ? "5,3" : undefined}
                    markerEnd={`url(#arrowhead-${edge.visualState})`}
                  />
                  <text
                    x={midPoint.x}
                    y={(midPoint.y ?? 0) - 6}
                    textAnchor="middle"
                    fill={EDGE_COLORS[edge.visualState]}
                    style={{ fontSize: "9px", fontStyle: "italic" }}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}

            {layout.nodes.map((node) => (
              <g
                key={node.id}
                onClick={() => navigate(`/tasks/${node.id}`)}
                className="cursor-pointer"
                data-testid={`dag-task-${node.id}`}
              >
                <rect
                  x={node.x - NODE_WIDTH / 2}
                  y={node.y - NODE_HEIGHT / 2}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={6}
                  ry={6}
                  fill={STATUS_FILL_COLORS[node.status] ?? "hsl(var(--card))"}
                  stroke={STATUS_BORDER_COLORS[node.status] ?? "hsl(var(--border))"}
                  strokeWidth={1.5}
                />
                <text
                  x={node.x}
                  y={node.y - 4}
                  textAnchor="middle"
                  fill="hsl(var(--foreground))"
                  style={{ fontSize: "11px", fontWeight: 600 }}
                >
                  {node.title.length > 18 ? `${node.title.slice(0, 18)}…` : node.title}
                </text>
                <text
                  x={node.x}
                  y={node.y + 12}
                  textAnchor="middle"
                  fill="hsl(var(--muted-foreground))"
                  style={{ fontSize: "9px" }}
                >
                  {node.status}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          Workflow has no gates. Tasks are independent.
        </div>
      )}

      {selectedGate && (
        <WorkflowGatePanel
          gate={selectedGate}
          upstreamTask={
            selectedUpstreamTask
              ? {
                  id: selectedUpstreamTask.id,
                  title: selectedUpstreamTask.title,
                  status: selectedUpstreamTask.status,
                }
              : undefined
          }
          downstreamTask={
            selectedDownstreamTask
              ? {
                  id: selectedDownstreamTask.id,
                  title: selectedDownstreamTask.title,
                  status: selectedDownstreamTask.status,
                }
              : undefined
          }
          isAdmin={isAdmin}
          unblocking={unblockMutation.isPending}
          onUnblock={() => unblockMutation.mutate(selectedGate.id)}
          onClose={() => setSelectedGateId(null)}
          onNavigateTask={(taskId) => navigate(`/tasks/${taskId}`)}
        />
      )}
    </div>
  );
}
