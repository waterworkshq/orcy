import { api } from '../client.js';
import { getOrcyConfig } from '@orcy/shared';
import { withErrorHandling } from '../error-handler.js';

export function registerMessageCommands(program: any) {
  const msg = program.command('message').description('Agent message operations');

  msg.command('send')
    .description('Send a message to another agent')
    .argument('<habitatId>', 'Habitat UUID')
    .argument('<subject>', 'Message subject')
    .argument('<body>', 'Message body')
    .option('--to-agent-id <id>', 'Recipient agent UUID')
    .option('--to-agent-name <name>', 'Recipient agent name (resolved automatically)')
    .option('--task-id <id>', 'Optional task UUID to scope the message')
    .option('--message-type <type>', 'Message type: info, request, response, alert')
    .option('--priority <priority>', 'Priority: low, normal, high, urgent')
    .action(withErrorHandling(async (habitatId: string, subject: string, body: string, options: any) => {
      let toAgentId = options.toAgentId;
      if (!toAgentId && options.toAgentName) {
        const agents = await api.get<any>(`/api/agents?name=${encodeURIComponent(options.toAgentName)}`);
        const list = agents.agents ?? [];
        const found = list.find((a: any) => (a.agent?.name ?? a.name) === options.toAgentName);
        if (!found) throw new Error(`Agent "${options.toAgentName}" not found`);
        toAgentId = found.agent?.id ?? found.id;
      }
      if (!toAgentId) throw new Error('Either --to-agent-id or --to-agent-name must be provided');
      const config = getOrcyConfig();
      const agentId = config.agentId;
      const result = await api.post<any>(`/api/agents/${agentId}/messages`, {
        habitatId,
        toAgentId,
        taskId: options.taskId,
        subject,
        body,
        messageType: options.messageType ?? 'info',
        priority: options.priority ?? 'normal',
      });
      console.log(JSON.stringify(result, null, 2));
    }));

  msg.command('get-messages')
    .description('List messages addressed to you')
    .option('--unread-only', 'Only return unread messages')
    .option('--task-id <id>', 'Filter by task')
    .option('--limit <n>', 'Max messages', '50')
    .option('--offset <n>', 'Messages to skip', '0')
    .action(withErrorHandling(async (options: { unreadOnly?: boolean; taskId?: string; limit: string; offset: string }) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      const params = new URLSearchParams();
      if (options.unreadOnly) params.set('unreadOnly', 'true');
      if (options.taskId) params.set('taskId', options.taskId);
      params.set('limit', options.limit);
      params.set('offset', options.offset);
      const result = await api.get<any>(`/api/agents/${agentId}/messages?${params}`);
      console.log(JSON.stringify(result, null, 2));
    }));
}
