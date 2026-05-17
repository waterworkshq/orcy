import React, { useState } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogContent, DialogFooter } from './Dialog.js';
import { Button } from './Button.js';
import { api } from '../../api/index.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import { Copy, Check, Download, AlertCircle } from 'lucide-react';

interface AgentRegistrationDialogProps {
  open: boolean;
  onClose: () => void;
  onRegistered?: () => void;
}

type AgentType = 'claude-code' | 'codex' | 'opencode';

const AGENT_TYPES: { value: AgentType; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
];

const DOMAINS = [
  { value: 'frontend', label: 'Frontend' },
  { value: 'backend', label: 'Backend' },
  { value: 'devops', label: 'DevOps' },
  { value: 'testing', label: 'Testing' },
  { value: 'fullstack', label: 'Full Stack' },
];

export function AgentRegistrationDialog({ open, onClose, onRegistered }: AgentRegistrationDialogProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AgentType>('opencode');
  const [domain, setDomain] = useState('backend');
  const [capabilities, setCapabilities] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAgent, setCreatedAgent] = useState<{ agent: { id: string; name: string }; apiKey: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const { upsertAgent } = useHabitatStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Agent name is required');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const caps = capabilities
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      const result = await api.agents.create({
        name: name.trim(),
        type,
        domain,
        capabilities: caps.length > 0 ? caps : undefined,
      });

      upsertAgent(result.agent);
      setCreatedAgent(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!createdAgent) return;
    const config = `ORCY_API_URL=http://localhost:3000
ORCY_AGENT_ID=${createdAgent.agent.id}
ORCY_API_KEY=${createdAgent.apiKey}`;
    await navigator.clipboard.writeText(config);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!createdAgent) return;
    const config = `ORCY_API_URL=http://localhost:3000
ORCY_AGENT_ID=${createdAgent.agent.id}
ORCY_API_KEY=${createdAgent.apiKey}`;
    const blob = new Blob([config], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '.env.orcy';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    setCreatedAgent(null);
    setName('');
    setType('opencode');
    setDomain('backend');
    setCapabilities('');
    setError(null);
    setCopied(false);
    onClose();
    if (createdAgent) {
      onRegistered?.();
    }
  };

  return (
    <Dialog open={open} onClose={handleClose}>
      {!createdAgent ? (
        <>
          <DialogHeader>
            <DialogTitle>Register Agent</DialogTitle>
            <DialogDescription>
              Create a new AI agent that can connect via MCP to work on tasks.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit}>
            <DialogContent className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 rounded bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="agent-name" className="text-sm font-medium">
                  Agent Name
                </label>
                <input
                  id="agent-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., coding-agent-1"
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="agent-type" className="text-sm font-medium">
                  Agent Type
                </label>
                <select
                  id="agent-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as AgentType)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {AGENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label htmlFor="agent-domain" className="text-sm font-medium">
                  Domain
                </label>
                <select
                  id="agent-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {DOMAINS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label htmlFor="agent-capabilities" className="text-sm font-medium">
                  Capabilities{' '}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <input
                  id="agent-capabilities"
                  type="text"
                  value={capabilities}
                  onChange={(e) => setCapabilities(e.target.value)}
                  placeholder="e.g., typescript, react, node"
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated list of specific skills or technologies.
                </p>
              </div>
            </DialogContent>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? 'Creating...' : 'Register Agent'}
              </Button>
            </DialogFooter>
          </form>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>Agent Registered</DialogTitle>
            <DialogDescription>
              Your agent <strong>{createdAgent.agent.name}</strong> has been created.
              Copy these credentials — they will not be shown again.
            </DialogDescription>
          </DialogHeader>

          <DialogContent className="space-y-4">
            <div className="rounded border border-input bg-muted/50 p-4">
              <pre className="whitespace-pre-wrap text-sm font-mono">
                {`ORCY_API_URL=http://localhost:3000
ORCY_AGENT_ID=${createdAgent.agent.id}
ORCY_API_KEY=${createdAgent.apiKey}`}
              </pre>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleCopy}
              >
                {copied ? (
                  <>
                    <Check className="mr-1 h-4 w-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-4 w-4" /> Copy Credentials
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleDownload}
              >
                <Download className="mr-1 h-4 w-4" /> Download .env
              </Button>
            </div>

            <div className="rounded bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
              <p className="font-medium">Next Steps:</p>
              <ol className="mt-1 list-inside list-decimal space-y-1">
                <li>Add these credentials to your agent's environment</li>
                <li>Configure your agent's <code className="text-xs">.mcp.json</code> file</li>
                <li>The agent will then be able to claim and work on tasks</li>
              </ol>
            </div>
          </DialogContent>

          <DialogFooter>
            <Button onClick={handleClose}>Done</Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
