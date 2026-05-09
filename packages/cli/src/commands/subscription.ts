import { api } from '../client.js';

export function registerSubscriptionCommands(program: any) {
  const sub = program.command('subscription').description('Real-time event subscription operations');

  sub.command('subscribe')
    .description('Subscribe to real-time board events')
    .argument('<boardId>', 'Habitat UUID')
    .action(async (boardId: string) => {
      const agentId = process.env.ORCY_AGENT_ID ?? '';
      if (!agentId) throw new Error('ORCY_AGENT_ID not configured');
      const result = await api.post<any>(`/api/boards/${boardId}/subscribe`, { agentId });
      console.log(JSON.stringify(result, null, 2));
    });

  sub.command('unsubscribe')
    .description('Unsubscribe from real-time board events')
    .argument('<boardId>', 'Habitat UUID')
    .action(async (boardId: string) => {
      const agentId = process.env.ORCY_AGENT_ID ?? '';
      if (!agentId) throw new Error('ORCY_AGENT_ID not configured');
      const result = await api.post<any>(`/api/boards/${boardId}/unsubscribe`, { agentId });
      console.log(JSON.stringify(result, null, 2));
    });
}
