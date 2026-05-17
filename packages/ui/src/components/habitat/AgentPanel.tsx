import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/Button.js';
import { AgentRegistrationDialog } from '../ui/AgentRegistrationDialog.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { useAgentsListWithTasks, useAgentStats } from '../../lib/useHabitatData.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { X, Plus } from 'lucide-react';
import { Drawer } from '../ui/Drawer.js';
import { AgentCard } from './AgentCard.js';
import type { Agent } from '../../types/index.js';

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

interface AgentPanelProps {
  onClose: () => void;
}

export function AgentPanel({ onClose }: AgentPanelProps) {
  const board = useHabitatStore((s) => s.board);
  const removeAgent = useHabitatStore((s) => s.removeAgent);
  const qc = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  const agentsQuery = useAgentsListWithTasks(board?.id);
  const agents = agentsQuery.data ?? [];

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
      removeAgent(pendingAgentId);
      await qc.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
      await qc.invalidateQueries({ queryKey: queryKeys.agents.list() });
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
        </div>
      </div>

      <AgentRegistrationDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onRegistered={async () => {
          await qc.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
        }}
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
