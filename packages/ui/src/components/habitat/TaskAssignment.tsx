import React from 'react';
import { Button } from '../ui/Button.js';
import { User, ArrowRight } from 'lucide-react';
import { Badge } from '../ui/Badge.js';
import type { Agent } from '../../types/index.js';

interface TaskAssignmentProps {
  task: {
    assignedAgentId: string | null;
    delegatedToAgentId: string | null;
    status: string;
  };
  agents: Agent[];
  showDelegate: boolean;
  delegateAgentId: string;
  delegating: boolean;
  onShowDelegate: (v: boolean) => void;
  onDelegateAgentIdChange: (v: string) => void;
  onDelegate: () => void;
}

function getAgentDisplayName(agentId: string | null | undefined, agents: Agent[]): string {
  if (!agentId) return 'Unassigned';
  const agent = agents.find((a) => a.id === agentId);
  return agent ? agent.name : 'Agent not found';
}

export function TaskAssignment({
  task,
  agents,
  showDelegate,
  delegateAgentId,
  delegating,
  onShowDelegate,
  onDelegateAgentIdChange,
  onDelegate,
}: TaskAssignmentProps) {
  if (!task.assignedAgentId) return null;

  const assignedAgent = agents.find((a) => a.id === task.assignedAgentId);
  const targetAgent = task.delegatedToAgentId ? agents.find((a) => a.id === task.delegatedToAgentId) : null;

  return (
    <div className="mb-4">
      <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Assigned To</h4>
      <div className="flex items-center gap-2 text-sm">
        <User className="h-4 w-4 text-muted-foreground" />
        <span>{assignedAgent ? assignedAgent.name : 'Agent not found'}</span>
        {assignedAgent && (
          <Badge
            variant={assignedAgent.status === 'idle' ? 'done' : assignedAgent.status === 'working' ? 'in_progress' : 'failed'}
            className="text-xs"
          >
            {assignedAgent.status}
          </Badge>
        )}
      </div>

      {task.delegatedToAgentId && (
        <div className="mt-2 flex items-center gap-2 rounded bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 text-sm">
          <ArrowRight className="h-3.5 w-3.5 text-amber-600" />
          <span className="text-amber-700 dark:text-amber-400">Delegated to</span>
          <span className="font-medium">{targetAgent ? targetAgent.name : 'unknown agent'}</span>
        </div>
      )}

      {!task.delegatedToAgentId && (task.status === 'claimed' || task.status === 'in_progress') && agents.length > 1 && (
        <div className="mt-2">
          {!showDelegate ? (
            <Button variant="outline" size="sm" onClick={() => onShowDelegate(true)}>
              <ArrowRight className="h-3.5 w-3.5 mr-1" />
              Delegate
            </Button>
          ) : (
            <div className="space-y-2 rounded border p-2">
              <select
                value={delegateAgentId}
                onChange={(e) => onDelegateAgentIdChange(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Select agent...</option>
                {agents
                  .filter((a) => a.id !== task.assignedAgentId)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.domain}) — {agent.status}
                    </option>
                  ))}
              </select>
              <div className="flex gap-2">
                <Button size="sm" onClick={onDelegate} disabled={!delegateAgentId || delegating}>
                  {delegating ? 'Delegating...' : 'Delegate'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { onShowDelegate(false); onDelegateAgentIdChange(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
