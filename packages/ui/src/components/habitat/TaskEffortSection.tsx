import React, { useState } from "react";
import { DetailCard } from "../ui/DetailCard.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Clock, Plus, Pencil } from "lucide-react";
import { useTaskEffortReport, useLogEffort, useCorrectEffortEntry } from "../../hooks/useEffort.js";
import type { EffortSource } from "../../types/index.js";

interface TaskEffortSectionProps {
  taskId: string;
}

const sourceLabels: Record<EffortSource, string> = {
  human_manual: "Manual",
  agent_reported: "Agent",
  correction_adjustment: "Corrected",
};

const sourceBadgeVariant: Record<EffortSource, "default" | "in_progress" | "submitted"> = {
  human_manual: "default",
  agent_reported: "in_progress",
  correction_adjustment: "submitted",
};

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function TaskEffortSection({ taskId }: TaskEffortSectionProps) {
  const { data: report, isLoading } = useTaskEffortReport(taskId);
  const logEffort = useLogEffort(taskId);
  const correctEffort = useCorrectEffortEntry(taskId);

  const [showLogForm, setShowLogForm] = useState(false);
  const [logMinutes, setLogMinutes] = useState("");
  const [logNote, setLogNote] = useState("");

  const [correctingEntryId, setCorrectingEntryId] = useState<string | null>(null);
  const [correctionDelta, setCorrectionDelta] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");

  if (isLoading) {
    return (
      <DetailCard icon={Clock} title="Effort" className="mb-4">
        <div className="space-y-3" aria-busy="true" aria-label="Loading effort summary">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-7 w-24 animate-pulse rounded bg-muted" />
        </div>
      </DetailCard>
    );
  }

  const totals = report?.totals;
  const entries = report?.entries ?? [];
  const estimate = report?.estimate?.plannedMinutes;

  const loggedMin = totals?.loggedEffortMinutes ?? 0;
  const inferredMin = totals?.inferredPresenceMinutes ?? 0;
  const totalMin = totals?.totalAccountedMinutes ?? 0;

  function handleLogSubmit(e: React.FormEvent) {
    e.preventDefault();
    const mins = parseInt(logMinutes, 10);
    if (!mins || mins <= 0) return;
    logEffort.mutate(
      { minutes: mins, note: logNote || undefined },
      {
        onSuccess: () => {
          setShowLogForm(false);
          setLogMinutes("");
          setLogNote("");
        },
      },
    );
  }

  function handleCorrectSubmit(e: React.FormEvent, entryId: string) {
    e.preventDefault();
    const delta = parseInt(correctionDelta, 10);
    if (!delta || !correctionReason.trim()) return;
    correctEffort.mutate(
      { entryId, minutesDelta: delta, correctionReason: correctionReason.trim() },
      {
        onSuccess: () => {
          setCorrectingEntryId(null);
          setCorrectionDelta("");
          setCorrectionReason("");
        },
      },
    );
  }

  return (
    <DetailCard icon={Clock} title="Effort" className="mb-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-sm">
          {estimate != null && <span className="text-muted-foreground">Est: {estimate}m</span>}
          <span className="text-muted-foreground">Logged: {loggedMin}m</span>
          {inferredMin > 0 && (
            <>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">Inferred: {inferredMin}m</span>
            </>
          )}
          <span className="text-muted-foreground">|</span>
          <span className="font-medium">Total: {totalMin}m</span>
        </div>

        {!showLogForm ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowLogForm(true)}
            className="h-7 gap-1 text-xs"
          >
            <Plus className="h-3 w-3" />
            Log Effort
          </Button>
        ) : (
          <form onSubmit={handleLogSubmit} className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                placeholder="Minutes"
                value={logMinutes}
                onChange={(e) => setLogMinutes(e.target.value)}
                className="w-24 rounded border bg-transparent px-2 py-1 text-sm"
                autoFocus
              />
              <input
                type="text"
                placeholder="Note (optional)"
                value={logNote}
                onChange={(e) => setLogNote(e.target.value)}
                className="flex-1 rounded border bg-transparent px-2 py-1 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={logEffort.isPending}
                className="h-7 text-xs"
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowLogForm(false);
                  setLogMinutes("");
                  setLogNote("");
                }}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {entries.length === 0 && !showLogForm && (
          <p className="text-xs text-muted-foreground">No effort logged</p>
        )}

        {entries.length > 0 && (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={sourceBadgeVariant[entry.source]} className="text-[10px]">
                    {sourceLabels[entry.source]}
                  </Badge>
                  <span>{entry.minutes}m</span>
                  {entry.actorName && (
                    <span className="text-muted-foreground">{entry.actorName}</span>
                  )}
                  {entry.note && (
                    <span className="truncate text-muted-foreground" title={entry.note}>
                      — {entry.note}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelativeTime(entry.recordedAt)}
                  </span>
                  {entry.correctsEntryId === null && entry.source !== "correction_adjustment" && (
                    <button
                      onClick={() => {
                        setCorrectingEntryId(entry.id);
                        setCorrectionDelta("");
                        setCorrectionReason("");
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Correct entry"
                      aria-label="Correct entry"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {correctingEntryId === entry.id && (
                  <form
                    onSubmit={(e) => handleCorrectSubmit(e, entry.id)}
                    className="ml-4 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        placeholder="+/- minutes"
                        value={correctionDelta}
                        onChange={(e) => setCorrectionDelta(e.target.value)}
                        className="w-28 rounded border bg-transparent px-2 py-1 text-sm"
                        autoFocus
                      />
                      <input
                        type="text"
                        placeholder="Reason"
                        value={correctionReason}
                        onChange={(e) => setCorrectionReason(e.target.value)}
                        className="flex-1 rounded border bg-transparent px-2 py-1 text-sm"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={correctEffort.isPending}
                        className="h-7 text-xs"
                      >
                        Correct
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCorrectingEntryId(null)}
                        className="h-7 text-xs"
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </DetailCard>
  );
}
