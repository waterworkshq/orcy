import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Tooltip } from '../ui/Tooltip.js';
import { AgentRegistrationDialog } from '../ui/AgentRegistrationDialog.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { useBoardStore } from '../../store/habitatStore.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { X, Plus, ChevronDown, ChevronRight, TrendingUp } from 'lucide-react';
import { Drawer } from '../ui/Drawer.js';
import type { AgentStats } from '../../types/index.js';

interface AgentPanelProps {
  onClose: () => void;
}

export function AgentPanel({ onClose }: AgentPanelProps) {
  const { agents, tasks, removeAgent } = useBoardStore();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (agents.length === 0) return;
    const stats: Record<string, AgentStats> = {};
    Promise.all(agents.map((a) => api.agents.stats(a.id)))
      .then((results) => {
        results.forEach((statsResult, i) => {
          stats[agents[i].id] = statsResult;
        });
        setAgentStats(stats);
      })
      .catch(() => {});
  }, [agents]);

  function toggleExpanded(agentId: string) {
    setExpandedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  }

  function formatCycleTime(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  function getRelativeTime(timestamp: string): string {
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function getAgentTask(agentId: string) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent?.currentTaskId) return null;
    return tasks.find((t) => t.id === agent.currentTaskId) ?? null;
  }

  function requestRemove(agentId: string) {
    setPendingAgentId(agentId);
    setConfirmOpen(true);
  }

  async function confirmRemove() {
    if (!pendingAgentId) return;
    try {
      await api.agents.delete(pendingAgentId);
      removeAgent(pendingAgentId);
      notify.success('Agent deregistered');
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setConfirmOpen(false);
      setPendingAgentId(null);
    }
  }

  return (
    <Drawer open={true} onClose={onClose} className="w-80">
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Agents</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(true)}>
              <Plus className="mr-1 h-3 w-3" /> Add
            </Button>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-muted-foreground">No agents registered.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="mr-1 h-3 w-3" /> Register Agent
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {agents.map((agent) => {
                const statusVariant = agent.status === 'idle'
                  ? 'done'
                  : agent.status === 'working'
                  ? 'in_progress'
                  : 'failed';

                const currentTask = getAgentTask(agent.id);

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
                        <Badge variant={statusVariant} className="text-xs">
                          {agent.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {getRelativeTime(agent.lastHeartbeat)}
                        </span>
                      </div>

                      {currentTask && (
                        <div className="rounded bg-secondary p-2">
                          <p className="text-xs text-muted-foreground">Working on:</p>
                          <p className="truncate text-xs font-medium">{currentTask.title}</p>
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

                      {agentStats[agent.id] && (
                        <div className="border-t pt-2">
                          <button
                            className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => toggleExpanded(agent.id)}
                          >
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              Metrics
                            </span>
                            {expandedAgents[agent.id] ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </button>

                          {expandedAgents[agent.id] && (
                            <div className="mt-2 space-y-1 text-xs">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Completed:</span>
                                <span className="font-medium">
                                  {agentStats[agent.id].tasks.completed}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Failed:</span>
                                <span className="font-medium">
                                  {agentStats[agent.id].tasks.failed}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Avg cycle:</span>
                                <span className="font-medium">
                                  {agentStats[agent.id].cycleTime.count > 0
                                    ? formatCycleTime(agentStats[agent.id].cycleTime.averageMinutes)
                                    : '—'}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Rejection rate:</span>
                                <span className="font-medium">
                                  {Math.round(agentStats[agent.id].quality.rejectionRate * 100)}%
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Streak:</span>
                                <span className="font-medium">
                                  {agentStats[agent.id].quality.currentStreak}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">7d throughput:</span>
                                <span className="font-medium">
                                  {agentStats[agent.id].throughput.last7d}
                                </span>
                              </div>
                              {agentStats[agent.id].artifacts.total > 0 && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Artifacts:</span>
                                  <span className="font-medium">
                                    {agentStats[agent.id].artifacts.total}
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
                        onClick={() => requestRemove(agent.id)}
                      >
                        Deregister
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <AgentRegistrationDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onRegistered={() => {}}
      />
      <ConfirmDialog
        open={confirmOpen}
        onConfirm={confirmRemove}
        onCancel={() => { setConfirmOpen(false); setPendingAgentId(null); }}
        title="Deregister Agent"
        description="This agent will be disconnected and cannot reclaim tasks. Continue?"
        confirmLabel="Deregister"
        variant="danger"
      />
    </Drawer>
  );
}
