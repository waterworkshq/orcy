import { api } from '../client.js';
import { getOrcyConfig } from '@orcy/shared';
import { withErrorHandling } from '../error-handler.js';

export function registerSubscriptionCommands(program: any) {
  const sub = program.command('subscription').description('Real-time event subscription operations');

  sub.command('subscribe')
    .description('Subscribe to real-time board events')
    .argument('<boardId>', 'Habitat UUID')
    .action(withErrorHandling(async (boardId: string) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      if (!agentId) throw new Error('ORCY_AGENT_ID not configured');
      const result = await api.post<any>(`/api/boards/${boardId}/subscribe`, { agentId });
      console.log(JSON.stringify(result, null, 2));
    }));

  sub.command('unsubscribe')
    .description('Unsubscribe from real-time board events')
    .argument('<boardId>', 'Habitat UUID')
    .action(withErrorHandling(async (boardId: string) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      if (!agentId) throw new Error('ORCY_AGENT_ID not configured');
      const result = await api.post<any>(`/api/boards/${boardId}/unsubscribe`, { agentId });
      console.log(JSON.stringify(result, null, 2));
    }));
}
