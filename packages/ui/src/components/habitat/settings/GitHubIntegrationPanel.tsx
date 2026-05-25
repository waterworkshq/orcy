import React, { useState } from 'react';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { Button } from '../../ui/Button.js';
import { ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import type { IntegrationConnectionView } from '../../../types/index.js';

interface GitHubIntegrationPanelProps {
  connection: IntegrationConnectionView;
  syncing: boolean;
  onSync: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onToggleAutoImport: (id: string, autoImport: boolean) => void;
  onDisconnect: (id: string) => void;
}

function formatSyncStatus(status: string | null): { label: string; color: string } {
  switch (status) {
    case 'success': return { label: 'Success', color: 'text-green-600' };
    case 'partial': return { label: 'Partial', color: 'text-yellow-600' };
    case 'failed': return { label: 'Failed', color: 'text-red-600' };
    case 'running': return { label: 'Running', color: 'text-blue-600' };
    default: return { label: 'Never synced', color: 'text-muted-foreground' };
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function GitHubIntegrationPanel({
  connection,
  syncing,
  onSync,
  onToggleEnabled,
  onToggleAutoImport,
  onDisconnect,
}: GitHubIntegrationPanelProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const syncStatus = formatSyncStatus(connection.lastSyncStatus);
  const repoFullName = `${connection.repositoryOwner}/${connection.repositoryName}`;

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase px-2 py-0.5 rounded bg-muted">
            GitHub
          </span>
          <span className="text-sm font-medium">{connection.name}</span>
          {!connection.enabled && (
            <span className="text-xs text-muted-foreground">(disabled)</span>
          )}
        </div>
        <ToggleSwitch
          checked={connection.enabled}
          onChange={(checked) => onToggleEnabled(connection.id, checked)}
        />
      </div>

      <div className="text-sm space-y-1.5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="w-24 shrink-0">Repository</span>
          <a
            href={`https://github.com/${repoFullName}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-foreground hover:underline"
          >
            {repoFullName}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="w-24 shrink-0">Auth</span>
          <span className="text-foreground">
            {connection.authMethod === 'pat' ? 'Personal Access Token' : connection.authMethod}
          </span>
          {connection.externalAccountName && (
            <span className="text-muted-foreground">({connection.externalAccountName})</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="w-24 shrink-0">Last Sync</span>
          <span className={syncStatus.color}>{syncStatus.label}</span>
          {connection.lastSyncAt && (
            <span className="text-xs">{formatDate(connection.lastSyncAt)}</span>
          )}
        </div>
        {connection.lastSyncError && (
          <div className="flex items-start gap-2 text-red-600 text-xs mt-1">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{connection.lastSyncError}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={connection.autoImport}
            onChange={(checked) => onToggleAutoImport(connection.id, checked)}
            disabled={!connection.enabled}
          />
          <span className="text-sm text-muted-foreground">Auto-import</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onSync(connection.id)}
            loading={syncing}
            disabled={!connection.enabled || !connection.pullEnabled}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Sync Now
          </Button>
          {confirmDisconnect ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="destructive" onClick={() => { onDisconnect(connection.id); setConfirmDisconnect(false); }}>
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setConfirmDisconnect(true)}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
