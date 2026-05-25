import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Tooltip } from '../ui/Tooltip.js';
import { ChevronDown, ChevronRight, TrendingUp } from 'lucide-react';
import { formatRelativeTime, formatMinutes } from '../../lib/formatting.js';
import { TASK_STATUS_BADGE } from '../../lib/status-maps.js';
import type { Agent, AgentStats } from '../../types/index.js';

interface AgentCardProps {
  agent: Agent;
  currentTaskTitle?: string | null;
  stats?: AgentStats;
  expanded: boolean;
  onToggleExpand: (agentId: string) => void;
  onDeregister: (agentId: string) => void;
}

const statusVariant = TASK_STATUS_BADGE;

export function AgentCard({
  agent,
  currentTaskTitle,
  stats,
  expanded,
  onToggleExpand,
  onDeregister,
}: AgentCardProps) {
  return (
    <Card key={agent.id}>
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm">{agent.name}</CardTitle>
            <p className="text-xs text-muted-foreground capitalize">
              {agent.type.replace('-', ' ')} · {agent.domain}
            </p>
          </div>
          <Tooltip content="Agents heartbeat every 5 minutes to avoid silence detection. Tasks idle >30 min are auto-released.">
            <div
              className={`mt-0.5 h-2.5 w-2.5 rounded-full ${
                agent.status === 'idle'
                  ? 'bg-[var(--badge-done)]'
                  : agent.status === 'working'
                  ? 'bg-[var(--badge-active)]'
                  : 'bg-[var(--badge-low)]'
              }`}
              title={agent.status}
            />
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        <div className="flex items-center justify-between">
          <Badge variant={statusVariant as any} className="text-xs">
            {agent.status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(agent.lastHeartbeat)}
          </span>
        </div>

        {currentTaskTitle && (
          <div className="rounded bg-secondary p-2">
            <p className="text-xs text-muted-foreground">Working on:</p>
            <p className="truncate text-xs font-medium">{currentTaskTitle}</p>
          </div>
        )}

        {agent.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.map((cap) => (
              <span key={cap} className="rounded bg-accent px-1.5 py-0.5 text-xs">
                {cap}
              </span>
            ))}
          </div>
        )}

        {stats && (
          <div className="border-t pt-2">
            <button
              className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onToggleExpand(agent.id)}
              data-testid={`metrics-toggle-${agent.id}`}
            >
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                Metrics
              </span>
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>

            {expanded && (
              <div className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Completed:</span>
                  <span className="font-medium">
                    {stats.tasks.completed}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Failed:</span>
                  <span className="font-medium">
                    {stats.tasks.failed}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg cycle:</span>
                  <span className="font-medium">
                    {stats.cycleTime.count > 0
                      ? formatMinutes(stats.cycleTime.averageMinutes)
                      : '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Rejection rate:</span>
                  <span className="font-medium">
                    {Math.round(stats.quality.rejectionRate * 100)}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Streak:</span>
                  <span className="font-medium">
                    {stats.quality.currentStreak}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">7d throughput:</span>
                  <span className="font-medium">
                    {stats.throughput.last7d}
                  </span>
                </div>
                {stats.artifacts.total > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Artifacts:</span>
                    <span className="font-medium">
                      {stats.artifacts.total}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs text-muted-foreground hover:text-destructive"
          onClick={() => onDeregister(agent.id)}
        >
          Deregister
        </Button>
      </CardContent>
    </Card>
  );
}
