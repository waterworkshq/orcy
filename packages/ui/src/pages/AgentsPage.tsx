import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { AgentRegistrationDialog } from "../components/ui/AgentRegistrationDialog.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent } from "../components/ui/Card.js";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.js";
import { notify } from "../lib/toast.js";
import { useAgentsListWithTasks, useAgentStats } from "../lib/useHabitatData.js";
import { queryKeys } from "../lib/queryKeys.js";
import { AgentCard } from "../components/habitat/AgentCard.js";
import { DaemonSection } from "../components/habitat/DaemonSection.js";
import { ArrowLeft, Bot, Loader2, Plus, Users } from "lucide-react";
import type { Agent } from "../types/index.js";

function AgentCardWithStats({
  agent,
  currentTaskTitle,
  expanded,
  onToggleExpand,
  onDeregister,
}: {
  agent: Agent;
  currentTaskTitle: string | null;
  expanded: boolean;
  onToggleExpand: (agentId: string) => void;
  onDeregister: (agentId: string) => void;
}) {
  const statsQuery = useAgentStats(agent.id);
  return (
    <AgentCard
      agent={agent}
      currentTaskTitle={currentTaskTitle}
      stats={statsQuery.data}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      onDeregister={onDeregister}
    />
  );
}

export function AgentsPage() {
  const qc = useQueryClient();
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);

  const agentsQuery = useAgentsListWithTasks("_global");
  const agents = agentsQuery.data ?? [];
  const loading = agentsQuery.isLoading;
  const error = agentsQuery.error;

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
      notify.success("Agent deregistered");
      await qc.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setConfirmOpen(false);
      setPendingAgentId(null);
    }
  }

  async function handleRegistered() {
    await qc.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
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
        <div className="mb-8">
          <DaemonSection />
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-on-surface-variant">Loading agents...</span>
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-error">{error.message}</div>
            </CardContent>
          </Card>
        )}

        {!loading && !error && agents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Users className="h-16 w-16 text-on-surface-variant/40 mb-4" />
            <h2 className="text-lg font-semibold text-on-surface mb-2">No agents registered</h2>
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
            {agents.map((item) => (
              <AgentCardWithStats
                key={item.agent.id}
                agent={item.agent}
                currentTaskTitle={item.currentTaskTitle}
                expanded={!!expandedAgents[item.agent.id]}
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
        onRegistered={handleRegistered}
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
