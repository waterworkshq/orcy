import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/index.js';
import { AgentRegistrationDialog } from '../components/ui/AgentRegistrationDialog.js';
import { Button } from '../components/ui/Button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card.js';
import { ConfirmDialog } from '../components/ui/ConfirmDialog.js';
import { notify } from '../lib/toast.js';
import { formatRelativeTime, formatMinutes } from '../lib/formatting.js';
import { AgentCard } from '../components/habitat/AgentCard.js';
import { ArrowLeft, Bot, ChevronDown, ChevronRight, Loader2, Plus, TrendingUp, Users } from 'lucide-react';
import type { Agent, AgentStats } from '../types/index.js';

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
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                currentTaskTitle={currentTaskTitles[agent.id] ?? null}
                stats={agentStats[agent.id]}
                expanded={!!expandedAgents[agent.id]}
                onToggleExpand={toggleExpanded}
                onDeregister={requestRemove}
              />
            ))}
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
