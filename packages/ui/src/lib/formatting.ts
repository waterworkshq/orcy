import React from "react";
import type { BadgeVariant } from "../components/ui/Badge.js";
import { AlertTriangle, Calendar, Clock } from "lucide-react";

export function formatRelativeTime(
  input: string | Date | null,
  opts?: { maxGranularity?: "hours" | "days"; fallbackToDate?: boolean },
): string {
  if (!input) return "just now";
  const date = input instanceof Date ? input : new Date(input);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const { maxGranularity, fallbackToDate } = opts ?? {};
  const diffHours = Math.floor(diffMins / 60);
  if (maxGranularity === "hours") {
    if (fallbackToDate) return date.toLocaleDateString();
    return `${diffHours}h ago`;
  }
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  if (fallbackToDate) return date.toLocaleDateString();
  return `${diffDays}d ago`;
}

export function formatMinutes(minutes: number, opts?: { showZeroAs?: string }): string {
  if (minutes === 0 && opts?.showZeroAs) return opts.showZeroAs;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 60000) return "< 1m";
  return formatMinutes(Math.round(ms / 60000));
}

export function truncateId(id: string, prefix: string): string {
  const hash = id.includes("-") ? id.slice(id.indexOf("-") + 1) : id;
  return `${prefix}-${hash.slice(0, 6)}`;
}

const dueColors: Record<string, string> = {
  overdue: "text-[var(--badge-blocked-text)]",
  approaching: "text-[var(--badge-review-text)]",
  ok: "text-[var(--on-surface-variant)]",
};

const dueIcons: Record<string, React.ReactNode> = {
  overdue: React.createElement(AlertTriangle, { className: "w-3 h-3" }),
  approaching: React.createElement(Clock, { className: "w-3 h-3" }),
  ok: React.createElement(Calendar, { className: "w-3 h-3" }),
};

export function formatDueDate(item: {
  dueAt: string | null;
  slaDeadlineAt: string | null;
  dueDateStatus?: string;
}): { text: string; color: string; icon: React.ReactNode } | null {
  const deadline = item.slaDeadlineAt ?? item.dueAt;
  if (!deadline) return null;
  let status = item.dueDateStatus ?? "ok";
  if (!item.dueDateStatus) {
    const ms = new Date(deadline).getTime() - Date.now();
    status = ms < 0 ? "overdue" : ms < 3600000 ? "approaching" : "ok";
  }
  const date = new Date(deadline);
  const isToday = new Date().toDateString() === date.toDateString();
  const text = isToday
    ? `Today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return { text, color: dueColors[status] ?? dueColors.ok, icon: dueIcons[status] ?? dueIcons.ok };
}

export const PRIORITY_VARIANT: Record<string, "critical" | "high" | "medium" | "low"> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

export const PRIORITY_BORDER_CLASS: Record<string, string> = {
  critical: "border-l-[3px] border-l-[var(--badge-critical)]",
  high: "border-l-[3px] border-l-[var(--badge-high)]",
  medium: "border-l-[3px] border-l-[var(--badge-medium)]",
  low: "border-l-[3px] border-l-[var(--badge-low)]",
};

export const PRIORITY_TOOLTIP: Record<string, string> = {
  critical: "Critical priority",
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

export const TASK_STATUS_VARIANT: Record<
  string,
  "pending" | "claimed" | "in_progress" | "submitted" | "approved" | "rejected" | "done" | "failed"
> = {
  pending: "pending",
  claimed: "claimed",
  in_progress: "in_progress",
  submitted: "submitted",
  approved: "approved",
  rejected: "rejected",
  done: "done",
  failed: "failed",
};

export const FEATURE_STATUS_VARIANT: Record<string, BadgeVariant> = {
  not_started: "pending",
  in_progress: "in_progress",
  review: "submitted",
  done: "done",
  failed: "failed",
};
