import React, { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitHubIntegrationPanel } from './GitHubIntegrationPanel.js';
import { useIntegrations } from '../../../lib/useHabitatData.js';
import { queryKeys } from '../../../lib/queryKeys.js';
import { api } from '../../../api/index.js';
import { notify } from '../../../lib/toast.js';
import { Button } from '../../ui/Button.js';
import { Loader2, ExternalLink } from 'lucide-react';

interface IntegrationsTabProps {
  habitatId: string;
}

export function IntegrationsTab({ habitatId }: IntegrationsTabProps) {
  const { data, isLoading } = useIntegrations(habitatId);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [showPatForm, setShowPatForm] = useState(false);
  const [patName, setPatName] = useState('');
  const [patToken, setPatToken] = useState('');
  const [patOwner, setPatOwner] = useState('');
  const [patRepo, setPatRepo] = useState('');
  const [patAutoImport, setPatAutoImport] = useState(false);
  const [creating, setCreating] = useState(false);

  const [oauthStep, setOauthStep] = useState<'idle' | 'showing-code' | 'polling'>('idle');
  const [oauthUserCode, setOauthUserCode] = useState('');
  const [oauthVerificationUri, setOauthVerificationUri] = useState('');
  const [_oauthDeviceCode, setOauthDeviceCode] = useState('');
  const [_oauthPollInterval, setOauthPollInterval] = useState(5);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const qc = useQueryClient();

  const connections = data?.integrations ?? [];
  const githubConnections = connections.filter((c) => c.provider === 'github');

  function invalidate() {
    qc.invalidateQueries({ queryKey: queryKeys.integrations.list(habitatId) });
  }

  async function handleSync(connectionId: string) {
    setSyncingId(connectionId);
    try {
      const result = await api.integrations.sync(connectionId);
      notify.success(`Synced: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
      invalidate();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSyncingId(null);
    }
  }

  async function handleToggleEnabled(connectionId: string, enabled: boolean) {
    try {
      await api.integrations.update(connectionId, { enabled });
      invalidate();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleToggleAutoImport(connectionId: string, autoImport: boolean) {
    try {
      await api.integrations.update(connectionId, { autoImport });
      invalidate();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleDisconnect(connectionId: string) {
    try {
      await api.integrations.disable(connectionId);
      notify.success('Connection disconnected');
      invalidate();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleCreatePat(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.integrations.createGitHubPat(habitatId, {
        name: patName,
        token: patToken,
        repositoryOwner: patOwner,
        repositoryName: patRepo,
        autoImport: patAutoImport,
      });
      notify.success('GitHub connection created');
      setShowPatForm(false);
      setPatName('');
      setPatToken('');
      setPatOwner('');
      setPatRepo('');
      setPatAutoImport(false);
      invalidate();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleStartOAuth() {
    setOauthError(null);
    setOauthStep('showing-code');
    try {
      const flow = await api.integrations.startGitHubDeviceFlow(habitatId);
      setOauthUserCode(flow.userCode);
      setOauthVerificationUri(flow.verificationUri);
      setOauthDeviceCode(flow.deviceCode);
      setOauthPollInterval(flow.interval);

      startPolling(flow.deviceCode, flow.interval);
    } catch (err) {
      setOauthError((err as Error).message);
      setOauthStep('idle');
    }
  }

  function startPolling(deviceCode: string, interval: number) {
    setOauthStep('polling');
    const poll = async () => {
      try {
        const result = await api.integrations.pollGitHubDeviceFlow(habitatId, { deviceCode });
        if (result.status === 'pending') {
          pollTimerRef.current = setTimeout(poll, interval * 1000);
          return;
        }
        if (result.integration) {
          notify.success('GitHub connected successfully');
          resetOAuth();
          invalidate();
          return;
        }
      } catch (err) {
        setOauthError((err as Error).message);
        resetOAuth();
      }
    };
    pollTimerRef.current = setTimeout(poll, interval * 1000);
  }

  function resetOAuth() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setOauthStep('idle');
    setOauthUserCode('');
    setOauthVerificationUri('');
    setOauthDeviceCode('');
    setOauthError(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-2">GitHub</h3>
        {isLoading ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-1" />
            Loading...
          </div>
        ) : githubConnections.length === 0 && !showPatForm && oauthStep === 'idle' ? (
          <div className="space-y-3">
            <div className="py-4 text-center text-sm text-muted-foreground">
              No GitHub connections. Connect a repository to import issues as missions.
            </div>
            <div className="flex flex-col items-center gap-2">
              <Button size="sm" onClick={handleStartOAuth}>
                Connect with GitHub
              </Button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => setShowPatForm(true)}
              >
                Use a personal access token instead
              </button>
            </div>
          </div>
        ) : (
          null
        )}

        {oauthStep !== 'idle' && (
          <div className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm font-medium">Authorizing with GitHub</span>
            </div>
            <div className="bg-accent rounded-md p-3 text-center space-y-2">
              <p className="text-xs text-muted-foreground">Enter this code at the verification URL:</p>
              <p className="text-2xl font-mono tracking-widest">{oauthUserCode}</p>
              <a
                href={oauthVerificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {oauthVerificationUri}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {oauthStep === 'polling'
                ? 'Waiting for authorization...'
                : 'Copy the code and open the URL above in your browser.'}
            </p>
            {oauthError && (
              <p className="text-xs text-red-600 text-center">{oauthError}</p>
            )}
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={resetOAuth}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {githubConnections.length > 0 && !showPatForm && oauthStep === 'idle' && (
          <div className="space-y-3">
            {githubConnections.map((conn) => (
              <GitHubIntegrationPanel
                key={conn.id}
                connection={conn}
                syncing={syncingId === conn.id}
                onSync={handleSync}
                onToggleEnabled={handleToggleEnabled}
                onToggleAutoImport={handleToggleAutoImport}
                onDisconnect={handleDisconnect}
              />
            ))}
            {!showPatForm && (
              <div className="flex flex-col items-center gap-2 pt-2 border-t">
                <Button size="sm" variant="outline" onClick={handleStartOAuth}>
                  Connect Another via GitHub
                </Button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={() => setShowPatForm(true)}
                >
                  Use a personal access token instead
                </button>
              </div>
            )}
          </div>
        )}

        {showPatForm && (
          <form onSubmit={handleCreatePat} className="border rounded-lg p-4 space-y-3 mt-3">
            <h4 className="text-sm font-medium">Connect via Personal Access Token</h4>
            <p className="text-xs text-muted-foreground">
              Advanced option. Provide a GitHub PAT with <code>repo</code> scope.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Connection Name</label>
                <input
                  type="text"
                  value={patName}
                  onChange={(e) => setPatName(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
                  placeholder="My GitHub Repo"
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Personal Access Token</label>
                <input
                  type="password"
                  value={patToken}
                  onChange={(e) => setPatToken(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
                  placeholder="ghp_..."
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Repository Owner</label>
                <input
                  type="text"
                  value={patOwner}
                  onChange={(e) => setPatOwner(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
                  placeholder="owner or org"
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Repository Name</label>
                <input
                  type="text"
                  value={patRepo}
                  onChange={(e) => setPatRepo(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
                  placeholder="my-repo"
                  required
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="pat-auto-import"
                checked={patAutoImport}
                onChange={(e) => setPatAutoImport(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="pat-auto-import" className="text-sm text-muted-foreground">
                Auto-import new issues as missions
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" loading={creating}>
                Connect
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowPatForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Other Providers</h3>
        <div className="py-4 text-center text-sm text-muted-foreground border rounded-lg">
          Jira and Linear integration is framework-ready for future support.
        </div>
      </div>
    </div>
  );
}
