import { api } from '../client.js';
import { getOrcyConfig } from '@orcy/shared';
import { withErrorHandling } from '../error-handler.js';

export function registerAgentCommands(program: any) {
  const agent = program.command('agent').description('Agent operations');

  agent.command('register')
    .description('Register a new AI agent')
    .argument('<name>', 'Unique agent name')
    .argument('<type>', 'Agent type: claude-code, codex, opencode')
    .argument('<domain>', 'Primary domain: frontend, backend, devops, testing, fullstack')
    .option('--capabilities <caps>', 'Comma-separated capabilities')
    .action(withErrorHandling(async (name: string, type: string, domain: string, options: { capabilities?: string }) => {
      const body: Record<string, any> = { name, type, domain };
      if (options.capabilities) body.capabilities = options.capabilities.split(',').map((s: string) => s.trim());
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = process.env.ORCY_REGISTRATION_TOKEN;
      if (token) headers['X-Registration-Token'] = token;
      const config = getOrcyConfig();
      const url = `${config.apiUrl}/api/agents`;
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => '')}`);
      const result = await res.json();
      console.log(JSON.stringify(result, null, 2));
    }));

  agent.command('list')
    .description('List registered agents')
    .option('--status <status>', 'Filter by status: idle, working, offline')
    .option('--domain <domain>', 'Filter by domain')
    .action(withErrorHandling(async (options: { status?: string; domain?: string }) => {
      const params = new URLSearchParams();
      if (options.status) params.set('status', options.status);
      if (options.domain) params.set('domain', options.domain);
      const qs = params.toString();
      const result = await api.get<any>(`/api/agents${qs ? `?${qs}` : ''}`);
      console.log(JSON.stringify(result, null, 2));
    }));

  agent.command('heartbeat')
    .description('Send heartbeat to keep task alive')
    .option('--task-id <id>', 'Current task UUID')
    .option('--progress <progress>', 'Progress description')
    .action(withErrorHandling(async (options: { taskId?: string; progress?: string }) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      const result = await api.post<any>(`/api/agents/${agentId}/heartbeat`, {
        taskId: options.taskId,
        progress: options.progress,
      });
      console.log(JSON.stringify(result, null, 2));
    }));

  agent.command('get-stats')
    .description('Get your performance statistics')
    .action(withErrorHandling(async () => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      const agent = await api.get<any>(`/api/agents/${agentId}`);
      const stats = await api.get<any>(`/api/agents/${agentId}/stats`);
      console.log(JSON.stringify({ agentId, ...agent, stats: stats.stats ?? stats }, null, 2));
    }));
}
