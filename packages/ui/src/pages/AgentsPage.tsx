import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/index.js';
import { AgentRegistrationDialog } from '../components/ui/AgentRegistrationDialog.js';
import { Badge } from '../components/ui/Badge.js';
import { Button } from '../components/ui/Button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card.js';
import { ConfirmDialog } from '../components/ui/ConfirmDialog.js';
import { Tooltip } from '../components/ui/Tooltip.js';
import { notify } from '../lib/toast.js';
import { ArrowLeft, Bot, ChevronDown, ChevronRight, Loader2, Plus, TrendingUp, Users } from 'lucide-react';
import type { Agent, AgentStats } from '../types/index.js';

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

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentTaskTitles, setCurrentTaskTitles] = useState<Record<string, string>>({});
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const agentListWithTasks = await api.agents.listWithTasks();
      setAgents(agentListWithTasks.map((a) => a.agent));

      const titles: Record<string, string> = {};
      for (const item of agentListWithTasks) {
        if (item.currentTaskTitle) {
          titles[item.agent.id] = item.currentTaskTitle;
        }
      }
      setCurrentTaskTitles(titles);

      const stats: Record<string, AgentStats> = {};
      await Promise.all(
        agentListWithTasks.map((a) =>
          api.agents.stats(a.agent.id).then((s) => {
            stats[a.agent.id] = s;
          }).catch(() => {})
        )
      );
      setAgentStats(stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  function toggleExpanded(agentId: string) {
    setExpandedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  }

  function requestRemove(agentId: string) {
    setPendingAgentId(agentId);
    setConfirmOpen(true);
  }

  async function confirmRemove() {
    if (!pendingAgentId) return;
    try {
      await api.agents.delete(pendingAgentId);
      notify.success('Agent deregistered');
      setAgents((prev) => prev.filter((a) => a.id !== pendingAgentId));
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setConfirmOpen(false);
      setPendingAgentId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="glass-panel ghost-border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <Bot className="h-6 w-6 text-primary" />
                <h1 className="text-xl font-bold text-on-surface">Agents</h1>
              </div>
            </div>
            <Button size="sm" onClick={() => setShowRegisterDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Register Agent
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-on-surface-variant">Loading agents...</span>
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-error">{error}</div>
            </CardContent>
          </Card>
        )}

        {!loading && !error && agents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Users className="h-16 w-16 text-on-surface-variant/40 mb-4" />
            <h2 className="text-lg font-semibold text-on-surface mb-2">
              No agents registered
            </h2>
            <p className="text-sm text-on-surface-variant mb-6">
              Register an AI agent to start working on tasks.
            </p>
            <Button onClick={() => setShowRegisterDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Register Agent
            </Button>
          </div>
        )}

        {!loading && !error && agents.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((agent) => {
              const statusVariant =
                agent.status === 'idle'
                  ? 'done'
                  : agent.status === 'working'
                  ? 'in_progress'
                  : 'failed';

              return (
                <Card key={agent.id}>
                  <CardHeader className="p-4 pb-2">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0">
                        <CardTitle className="text-sm truncate">{agent.name}</CardTitle>
                        <p className="text-xs text-muted-foreground capitalize">
                          {agent.type.replace('-', ' ')} · {agent.domain}
                        </p>
                      </div>
                      <Tooltip content="Agents heartbeat every 5 minutes to avoid silence detection. Tasks idle >30 min are auto-released.">
                        <div
                          className={`mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 ${
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
                  <CardContent className="p-4 pt-0 space-y-2">
                    <div className="flex items-center justify-between">
                      <Badge variant={statusVariant} className="text-xs">
                        {agent.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {getRelativeTime(agent.lastHeartbeat)}
                      </span>
                    </div>

                    {agent.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {agent.capabilities.map((cap) => (
                          <span key={cap} className="rounded bg-accent px-1.5 py-0.5 text-xs">
                            {cap}
                          </span>
                        ))}
                      </div>
                    )}

                    {currentTaskTitles[agent.id] && (
                      <div className="rounded bg-secondary p-2">
                        <p className="text-xs text-muted-foreground">Working on:</p>
                        <p className="truncate text-xs font-medium">{currentTaskTitles[agent.id]}</p>
                      </div>
                    )}

                    {agentStats[agent.id] && (
                      <div className="border-t pt-2">
                        <button
                          className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => toggleExpanded(agent.id)}
                          data-testid={`metrics-toggle-${agent.id}`}
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
      </main>

      <AgentRegistrationDialog
        open={showRegisterDialog}
        onClose={() => setShowRegisterDialog(false)}
        onRegistered={() => fetchAgents()}
      />
      <ConfirmDialog
        open={confirmOpen}
        onConfirm={confirmRemove}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingAgentId(null);
        }}
        title="Deregister Agent"
        description="This agent will be disconnected and cannot reclaim tasks. Continue?"
        confirmLabel="Deregister"
        variant="danger"
      />
    </div>
  );
}
