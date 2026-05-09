import React from 'react';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { Button } from '../../ui/Button.js';
import type { ChatIntegration } from '../../../types/index.js';

interface ChatIntegrationListProps {
  integrations: ChatIntegration[];
  testing: string | null;
  onTest: (id: string) => void;
  onEdit: (integration: ChatIntegration) => void;
  onDelete: (id: string) => void;
  onToggle: (integration: ChatIntegration) => void;
  onAdd: () => void;
  loading: boolean;
}

export function ChatIntegrationList({
  integrations,
  testing,
  onTest,
  onEdit,
  onDelete,
  onToggle,
  onAdd,
  loading,
}: ChatIntegrationListProps) {
  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={onAdd}>Add Integration</Button>
      </div>
      {loading ? (
        <div className="py-4 text-center text-sm text-muted-foreground">Loading...</div>
      ) : integrations.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No chat integrations configured. Add one to push task events to Slack or Discord.
        </div>
      ) : (
        <div className="space-y-3">
          {integrations.map((integration) => (
            <div key={integration.id} className="border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase px-2 py-0.5 rounded bg-muted">
                    {integration.provider}
                  </span>
                  <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                    {integration.webhookUrl}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    checked={!!integration.enabled}
                    onChange={() => onToggle(integration)}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onTest(integration.id)}
                  loading={testing === integration.id}
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(integration)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => onDelete(integration.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
