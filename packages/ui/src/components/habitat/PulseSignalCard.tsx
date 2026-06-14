import React from "react";
import {
  Search,
  ShieldAlert,
  Handshake,
  TriangleAlert,
  HelpCircle,
  MessageCircle,
  Command,
  Info,
  ArrowRightLeft,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { formatRelativeTime } from "./MissionHeader.js";
import { PulseReactions } from "./PulseReactions.js";
import type { Pulse, SignalType, PulseReactionCounts } from "../../types/index.js";

const SIGNAL_CONFIG: Record<SignalType, { icon: LucideIcon; label: string; color: string }> = {
  finding: { icon: Search, label: "Finding", color: "var(--primary)" },
  blocker: { icon: ShieldAlert, label: "Blocker", color: "var(--error)" },
  offer: { icon: Handshake, label: "Offer", color: "var(--tertiary)" },
  warning: { icon: TriangleAlert, label: "Warning", color: "hsl(40,90%,55%)" },
  question: { icon: HelpCircle, label: "Question", color: "var(--secondary)" },
  answer: { icon: MessageCircle, label: "Answer", color: "var(--secondary)" },
  directive: { icon: Command, label: "Directive", color: "hsl(280,70%,60%)" },
  context: { icon: Info, label: "Context", color: "var(--on-surface-variant)" },
  handoff: { icon: ArrowRightLeft, label: "Handoff", color: "hsl(200,70%,60%)" },
};

interface PulseSignalCardProps {
  pulse: Pulse;
  missionId: string;
  reactionCounts?: PulseReactionCounts;
  habitatId?: string;
}

export function PulseSignalCard({
  pulse,
  missionId,
  reactionCounts,
  habitatId,
}: PulseSignalCardProps) {
  const config = SIGNAL_CONFIG[pulse.signalType];
  const Icon = config.icon;

  return (
    <div
      className={`rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/60 overflow-hidden transition-colors hover:bg-[var(--surface-container)] ${
        pulse.isAuto ? "opacity-70" : ""
      }`}
      style={{ borderLeftWidth: "3px", borderLeftColor: config.color }}
    >
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`,
              color: config.color,
            }}
          >
            <Icon className="h-3 w-3" />
            {config.label}
          </span>
          <span
            className={`text-[11px] font-medium text-[var(--on-surface)] ${pulse.isAuto ? "text-[11px]" : "text-xs"}`}
          >
            {pulse.fromType === "system"
              ? "System"
              : pulse.fromType === "remote_human"
                ? `Remote: ${pulse.fromId.slice(0, 8)}`
                : pulse.fromType === "remote_orcy"
                  ? `Remote Or: ${pulse.fromId.slice(0, 8)}`
                  : pulse.fromId.slice(0, 8)}
          </span>
          <span className="text-[10px] text-[var(--on-surface-variant)]">
            {formatRelativeTime(pulse.createdAt)}
          </span>
          {pulse.isAuto && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] uppercase">
              Auto
            </span>
          )}
        </div>

        <div className="space-y-1">
          <p
            className={`font-semibold text-[var(--on-surface)] ${pulse.isAuto ? "text-xs" : "text-sm"}`}
          >
            {pulse.subject}
          </p>
          {pulse.body && (
            <p
              className={`text-[var(--on-surface-variant)] whitespace-pre-wrap ${pulse.isAuto ? "text-[11px] leading-relaxed" : "text-xs leading-relaxed"}`}
            >
              {pulse.body.length > 300 ? `${pulse.body.slice(0, 300)}...` : pulse.body}
            </p>
          )}
        </div>

        {(pulse.linkedTaskId || (pulse.signalType === "blocker" && pulse.taskId)) && (
          <div className="flex items-center gap-1.5">
            <ExternalLink className="h-3 w-3 text-[var(--on-surface-variant)]" />
            <span className="text-[10px] text-[var(--primary)]">
              {pulse.signalType === "blocker" && pulse.taskId
                ? `Clearance task: ${pulse.taskId.slice(0, 8)}`
                : `Task: ${(pulse.linkedTaskId ?? "").slice(0, 8)}`}
            </span>
          </div>
        )}

        <PulseReactions
          pulseId={pulse.id}
          missionId={missionId}
          habitatId={habitatId}
          counts={reactionCounts ?? { seen: 0, ack: 0, question: 0 }}
        />
      </div>
    </div>
  );
}
