import React from "react";
import { Badge } from "../ui/Badge.js";
import type { DaemonInfo } from "../../types/index.js";

interface DaemonCardProps {
  daemon: DaemonInfo;
  onStart?: (id: string) => void;
  onStop?: (id: string) => void;
  isActionLoading?: boolean;
  isActionDisabled?: boolean;
}

export function DaemonCard({
  daemon,
  onStart,
  onStop,
  isActionLoading,
  isActionDisabled,
}: DaemonCardProps) {
  const isOnline = daemon.status === "online";
  const disabled = isActionDisabled || isActionLoading;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">{daemon.name}</h4>
          <Badge variant={isOnline ? "claimed" : "failed"}>{isOnline ? "Online" : "Offline"}</Badge>
        </div>
        <div className="flex gap-2">
          {isOnline ? (
            <button
              type="button"
              onClick={() => onStop?.(daemon.id)}
              disabled={disabled}
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isActionLoading ? "Stopping..." : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onStart?.(daemon.id)}
              disabled={disabled}
              className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isActionLoading ? "Starting..." : "Start"}
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div>
          <span className="block font-medium text-foreground">{daemon.agentCount}</span>
          Agents
        </div>
        <div>
          <span className="block font-medium text-foreground">{daemon.activeSessionCount}</span>
          Active Sessions
        </div>
        <div>
          <span className="block font-medium text-foreground">{daemon.hostname}</span>
          Host
        </div>
      </div>
    </div>
  );
}
