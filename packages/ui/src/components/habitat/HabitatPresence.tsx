import React from "react";
import { Eye } from "lucide-react";
import { Tooltip } from "../ui/Tooltip.js";
import type { PresenceEntry } from "../../types/index.js";

interface HabitatPresenceProps {
  presence: PresenceEntry[];
  className?: string;
}

function viewerName(entry: PresenceEntry): string {
  return entry.userName ?? "Unknown";
}

function viewerLabel(entry: PresenceEntry): string {
  return viewerName(entry);
}

/** Live SSE viewers in this habitat. Not Inferred Presence / effort. */
export function HabitatPresence({ presence, className = "" }: HabitatPresenceProps) {
  if (presence.length === 0) return null;

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md bg-surface-container-high px-2 py-1 text-xs text-on-surface-variant ${className}`}
    >
      <Eye className="h-3.5 w-3.5" />
      <span>
        {presence.length} in habitat
      </span>
      <div className="ml-1 flex -space-x-1.5">
        {presence.slice(0, 3).map((entry) => {
          const label = viewerLabel(entry);
          const color = "bg-[var(--agent-blue)]";
          return (
            <Tooltip key={entry.sessionId} content={label}>
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full border border-surface text-[9px] font-bold text-[var(--on-surface)] ${color}`}
                aria-label={label}
              >
                {viewerName(entry).slice(0, 2).toUpperCase()}
              </div>
            </Tooltip>
          );
        })}
        {presence.length > 3 && (
          <div className="flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-surface-container-highest text-[9px] font-bold text-on-surface-variant">
            +{presence.length - 3}
          </div>
        )}
      </div>
    </div>
  );
}
