import { api } from '../client.js';
import { getOrcyConfig } from '@orcy/shared';
import { withErrorHandling } from '../error-handler.js';

export function registerSubscriptionCommands(program: any) {
  const sub = program.command('subscription').description('Real-time event subscription operations');

  sub.command('subscribe')
    .description('Subscribe to real-time habitat events')
    .argument('<habitatId>', 'Habitat UUID')
    .action(withErrorHandling(async (habitatId: string) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      if (!agentId) throw new Error('ORCY_AGENT_ID not configured');
      const result = await api.post<any>(`/api/habitats/${habitatId}/subscribe`, { agentId });
      console.log(JSON.stringify(result, null, 2));
    }));

  sub.command('unsubscribe')
    .description('Unsubscribe from real-time habitat events')
    .argument('<habitatId>', 'Habitat UUID')
    .action(withErrorHandling(async (habitatId: string) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      if (!agentId) throw new Error('ORCY_AGENT_ID not configured');
      const result = await api.post<any>(`/api/habitats/${habitatId}/unsubscribe`, { agentId });
      console.log(JSON.stringify(result, null, 2));
    }));
}
