import React from 'react';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { ArrowLeft, Clock, Tag, Calendar } from 'lucide-react';
import type { FeatureWithProgress } from '../../types/index.js';

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusBadgeVariant(status: string) {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress') return 'in_progress';
  return 'default';
}

interface FeatureHeaderProps {
  feature: FeatureWithProgress;
}

export function FeatureHeader({ feature }: FeatureHeaderProps) {
  const priorityVariant = feature.priority as
    | 'critical'
    | 'high'
    | 'medium'
    | 'low';

  return (
    <div className="cool-glow px-6 py-4 border-b border-[var(--outline-variant)] bg-[var(--surface-container)]/40">
      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold font-headline flex items-center gap-3 text-[var(--on-surface)]">
              <span className="truncate">{feature.title}</span>
              <Badge variant={priorityVariant}>{feature.priority}</Badge>
              <Badge variant={statusBadgeVariant(feature.status)}>
                {formatStatus(feature.status)}
              </Badge>
            </h1>
            <div className="flex items-center mt-1 text-[10px] text-[var(--on-surface-variant)] gap-3 uppercase tracking-tight">
              <span>ID: {feature.id.slice(0, 8)}</span>
              <span>\u2022</span>
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {formatRelativeTime(feature.createdAt)}
              </span>
              {feature.dueAt && (
                <>
                  <span>\u2022</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Due {formatRelativeTime(feature.dueAt)}
                  </span>
                </>
              )}
              <span>\u2022</span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Updated {formatRelativeTime(feature.updatedAt)}
              </span>
            </div>
            {feature.description && (
              <div className="mt-2 text-sm text-[var(--on-surface-variant)] max-w-2xl leading-relaxed prose prose-invert prose-sm">
                <Markdown>{feature.description}</Markdown>
              </div>
            )}
            {feature.labels.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2">
                <Tag className="h-3 w-3 text-[var(--on-surface-variant)]" />
                {feature.labels.map((label) => (
                  <span
                    key={label}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-container-high)] text-[var(--on-surface-variant)]"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 ml-4 shrink-0">
            <Link to={`/boards/${feature.boardId}`}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Habitat
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
