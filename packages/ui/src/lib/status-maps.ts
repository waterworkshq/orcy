export const TASK_STATUS_BADGE: Record<string, string> = {
  pending: 'glass-badge glass-badge-low',
  claimed: 'glass-badge glass-badge-active',
  in_progress: 'glass-badge glass-badge-active',
  submitted: 'glass-badge glass-badge-review',
  approved: 'glass-badge glass-badge-done',
  rejected: 'glass-badge glass-badge-blocked',
  done: 'glass-badge glass-badge-done',
  failed: 'glass-badge glass-badge-blocked',
};

export const FEATURE_STATUS_BADGE: Record<string, string> = {
  not_started: 'glass-badge glass-badge-low',
  in_progress: 'glass-badge glass-badge-active',
  review: 'glass-badge glass-badge-review',
  done: 'glass-badge glass-badge-done',
  failed: 'glass-badge glass-badge-blocked',
};

export const FEATURE_STATUS_DOT: Record<string, string> = {
  not_started: 'bg-[var(--badge-low)]',
  in_progress: 'bg-[var(--badge-active)]',
  review: 'bg-[var(--badge-review)]',
  done: 'bg-[var(--badge-done)]',
  failed: 'bg-[var(--badge-blocked)]',
};

export const PRIORITY_BADGE: Record<string, string> = {
  critical: 'glass-badge glass-badge-critical',
  high: 'glass-badge glass-badge-high',
  medium: 'glass-badge glass-badge-medium',
  low: 'glass-badge glass-badge-low',
};

export const SEVERITY_BADGE: Record<string, string> = {
  critical: 'glass-badge glass-badge-critical',
  high: 'glass-badge glass-badge-high',
  medium: 'glass-badge glass-badge-medium',
  low: 'glass-badge glass-badge-low',
};

export const QUALITY_STATUS_BADGE: Record<string, string> = {
  passed: 'glass-badge glass-badge-done',
  blocked: 'glass-badge glass-badge-blocked',
  in_progress: 'glass-badge glass-badge-review',
  pending: 'glass-badge glass-badge-low',
};

export function getStatusBadge(map: Record<string, string>, status: string): string {
  return map[status] ?? 'glass-badge glass-badge-low';
}
