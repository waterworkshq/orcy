import { api } from '../client.js';
import { getOrcyConfig } from '@orcy/shared';
import { withErrorHandling } from '../error-handler.js';

export function registerSuggestCommands(program: any) {
  const suggest = program.command('suggest').description('Task suggestion operations');

  suggest.command('suggest-next-task')
    .description('Get AI-ranked task suggestions')
    .argument('<boardId>', 'Habitat UUID')
    .option('--limit <n>', 'Max suggestions', '5')
    .action(withErrorHandling(async (boardId: string, options: { limit: string }) => {
      const config = getOrcyConfig();
      const agentId = config.agentId;
      const result = await api.get<any>(`/api/agents/${agentId}/suggestions?boardId=${encodeURIComponent(boardId)}&limit=${options.limit}`);
      console.log(JSON.stringify(result, null, 2));
    }));
}
