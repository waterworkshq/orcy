import React from "react";
import { Badge } from "../ui/Badge.js";
import type { DaemonInfo } from "../../types/index.js";

interface DaemonCardProps {
  daemon: DaemonInfo;
  onStart?: (id: string) => void;
  onStop?: (id: string) => void;
  onRecover?: (id: string, expectedIntent: string) => void;
  loadingAction?: "start" | "stop" | "recover" | null;
  isActionDisabled?: boolean;
}

export function DaemonCard({
  daemon,
  onStart,
  onStop,
  onRecover,
  loadingAction,
  isActionDisabled,
}: DaemonCardProps) {
  const isOnline = daemon.status === "online";
  const isUnknown = daemon.status === "unknown";
  const disabled = isActionDisabled || loadingAction != null;
  const showStop = isUnknown || loadingAction === "stop" || (isOnline && loadingAction !== "start");
  const showStart = isUnknown || loadingAction === "start" || (!isOnline && loadingAction !== "stop");

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">{daemon.name}</h4>
          <Badge variant={isOnline ? "claimed" : daemon.status === "unknown" ? "pending" : "failed"}>
            {isOnline ? "Online" : daemon.status === "unknown" ? "Unknown" : "Offline"}
          </Badge>
        </div>
        <div className="flex gap-2">
          {(loadingAction === "recover" || (isUnknown && daemon.stopIntentRef)) && (
            <button
              type="button"
              onClick={() => daemon.stopIntentRef && onRecover?.(daemon.id, daemon.stopIntentRef)}
              disabled={disabled}
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingAction === "recover" ? "Recovering..." : "Recover"}
            </button>
          )}
          {showStop && (
            <button
              type="button"
              onClick={() => onStop?.(daemon.id)}
              disabled={disabled}
              className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingAction === "stop" ? "Stopping..." : isUnknown ? "Retry Stop" : "Stop"}
            </button>
          )}
          {showStart && (
            <button
              type="button"
              onClick={() => onStart?.(daemon.id)}
              disabled={disabled}
              className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingAction === "start" ? "Starting..." : "Start"}
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
