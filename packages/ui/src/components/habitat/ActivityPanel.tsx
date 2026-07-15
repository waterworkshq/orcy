import React, { useState, useCallback } from "react";
import { Drawer } from "../ui/Drawer.js";
import { Button } from "../ui/Button.js";
import { api } from "../../api/index.js";
import { useHabitatStore } from "../../store/habitatStore.js";
import { useModalStore } from "../../store/modalStore.js";
import { useHabitatEvents, useHabitatAnomalies } from "../../lib/useHabitatData.js";
import { SEVERITY_BADGE } from "../../lib/status-maps.js";
import { CheckCircle, XCircle, User, Circle, Clock, AlertTriangle, Download } from "lucide-react";
import type { EnrichedHabitatEvent, EventAction } from "../../types/index.js";
import { AuditExportModal } from "./AuditExportModal.js";

interface ActivityPanelProps {
  onClose: () => void;
}

type FilterType = "all" | "claims" | "submissions" | "approvals" | "rejections";

const actionFilters: Record<FilterType, EventAction[]> = {
  all: [],
  claims: ["claimed"],
  submissions: ["submitted"],
  approvals: ["approved"],
  rejections: ["rejected"],
};

function formatRelativeTime(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

function getActionIcon(action: EventAction) {
  switch (action) {
    case "approved":
    case "completed":
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case "rejected":
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "claimed":
    case "started":
      return <User className="h-4 w-4 text-blue-500" />;
    case "created":
      return <Circle className="h-4 w-4 text-primary" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />;
  }
}

function getActionVerb(action: EventAction): string {
  switch (action) {
    case "created":
      return "created";
    case "claimed":
      return "claimed";
    case "started":
      return "started";
    case "submitted":
      return "submitted";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "moved":
      return "moved";
    case "released":
      return "released";
    case "dependency_resolved":
      return "resolved dependency for";
    case "updated":
      return "updated";
    default:
      return action;
  }
}

function EventRow({
  event,
  onTaskClick,
}: {
  event: EnrichedHabitatEvent;
  onTaskClick: (taskId: string) => void;
}) {
  const actorName =
    event.actorName ??
    (event.actorType === "human"
      ? "Human"
      : event.actorType === "system"
        ? "System"
        : event.actorType === "remote_human"
          ? `Remote: ${event.actorId.substring(0, 8)}`
          : event.actorType === "remote_orcy"
            ? `Remote Or: ${event.actorId.substring(0, 8)}`
            : event.actorType === "remote_pod"
              ? `Pod: ${event.actorId.substring(0, 8)}`
              : event.actorId.substring(0, 8));
  const verb = getActionVerb(event.action);

  let detail = "";
  if (event.fromColumnName && event.toColumnName) {
    detail = `${event.fromColumnName} → ${event.toColumnName}`;
  } else if (event.fromColumnName) {
    detail = `from ${event.fromColumnName}`;
  } else if (event.toColumnName) {
    detail = `to ${event.toColumnName}`;
  } else if (event.metadata && typeof event.metadata === "object" && "reason" in event.metadata) {
    detail = String((event.metadata as { reason: string }).reason);
  }

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors border-b"
      onClick={() => onTaskClick(event.taskId)}
    >
      <div className="mt-0.5">{getActionIcon(event.action)}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm">
          <span className="font-medium">{actorName}</span>{" "}
          <span className="text-muted-foreground">{verb}</span>{" "}
          <span
            className="font-medium text-primary hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onTaskClick(event.taskId);
            }}
          >
            "{event.taskTitle}"
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelativeTime(event.timestamp)}
          </span>
          {detail && (
            <>
              <span>·</span>
              <span>{detail}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ActivityPanel({ onClose }: ActivityPanelProps) {
  const { board } = useHabitatStore();
  const openModal = useModalStore((s) => s.openModal);
  const [filter, setFilter] = useState<FilterType>("all");
  const [extraEvents, setExtraEvents] = useState<EnrichedHabitatEvent[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [auditExportOpen, setAuditExportOpen] = useState(false);

  const habitatId = board?.id;
  const limit = 50;

  const actions = actionFilters[filter];
  const eventsQuery = useHabitatEvents(habitatId, {
    limit,
    offset: 0,
    action: actions.length === 1 ? actions[0] : undefined,
    ...(actions.length > 1 ? { actions: actions.join(",") } : {}),
  });

  const anomaliesQuery = useHabitatAnomalies(habitatId);

  const events = eventsQuery.data?.events ?? [];
  const total = eventsQuery.data?.total ?? 0;
  const allEvents = [...events, ...extraEvents];
  const hasMore = allEvents.length < total;

  const loadMore = useCallback(async () => {
    if (!habitatId || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const offset = limit + extraEvents.length;
      const { events: more } = await api.habitats.events(habitatId, {
        limit,
        offset,
        action: actions.length === 1 ? actions[0] : undefined,
        ...(actions.length > 1 ? { actions: actions.join(",") } : {}),
      });
      setExtraEvents((prev) => [...prev, ...more]);
    } catch (err) {
      console.warn("Failed to load more events:", err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [habitatId, isLoadingMore, extraEvents.length, actions]);

  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter);
    setExtraEvents([]);
  };

  const handleTaskClick = (taskId: string) => {
    openModal(taskId);
    onClose();
  };

  const anomalies = anomaliesQuery.data?.anomalies ?? [];
  const isLoading = eventsQuery.isLoading || anomaliesQuery.isLoading;

  const filteredEvents =
    filter === "all"
      ? allEvents
      : allEvents.filter((e) => actionFilters[filter].includes(e.action));

  return (
    <>
      <Drawer open={true} onClose={onClose} className="w-full max-w-md flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold">Activity Feed</h2>
          <div className="flex items-center gap-2">
            {habitatId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAuditExportOpen(true)}
                title="Export Audit Log"
              >
                <Download className="h-3.5 w-3.5 mr-1" />
                Export
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b overflow-x-auto">
          {(["all", "claims", "submissions", "approvals", "rejections"] as FilterType[]).map(
            (f) => (
              <Button
                key={f}
                variant={filter === f ? "secondary" : "ghost"}
                size="sm"
                onClick={() => handleFilterChange(f)}
                className="capitalize text-xs"
              >
                {f}
              </Button>
            ),
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {anomalies.length > 0 && (
            <div className="border-b border-border">
              <div className="px-4 py-2 bg-destructive/5">
                <h3 className="text-xs font-semibold text-destructive uppercase tracking-wide flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Active Anomalies ({anomalies.length})
                </h3>
              </div>
              {anomalies.map((anomaly, i) => {
                return (
                  <div
                    key={i}
                    className="flex items-start gap-3 px-4 py-3 border-b bg-destructive/5"
                  >
                    <AlertTriangle
                      className={`h-4 w-4 mt-0.5 ${anomaly.severity === "critical" ? "text-red-500" : anomaly.severity === "high" ? "text-orange-500" : anomaly.severity === "medium" ? "text-amber-500" : "text-blue-500"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-medium px-1.5 py-0.5 rounded ${SEVERITY_BADGE[anomaly.severity] ?? ""}`}
                        >
                          {anomaly.severity}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {anomaly.type.replace(/_/g, " ")}
                        </span>
                      </div>
                      <p className="text-sm mt-1">{anomaly.message}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {filteredEvents.length === 0 && !isLoading && anomalies.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
              No activity yet
            </div>
          ) : (
            <>
              {filteredEvents.map((event) => (
                <EventRow key={event.id} event={event} onTaskClick={handleTaskClick} />
              ))}
              {hasMore && (
                <div className="flex justify-center py-3">
                  <Button variant="ghost" size="sm" onClick={loadMore} disabled={isLoadingMore}>
                    {isLoadingMore ? "Loading..." : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>
      {habitatId && (
        <AuditExportModal
          habitatId={habitatId}
          open={auditExportOpen}
          onClose={() => setAuditExportOpen(false)}
        />
      )}
    </>
  );
}
