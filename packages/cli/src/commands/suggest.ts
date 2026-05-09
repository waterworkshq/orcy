import { api } from '../client.js';

export function registerSuggestCommands(program: any) {
  const suggest = program.command('suggest').description('Task suggestion operations');

  suggest.command('suggest-next-task')
    .description('Get AI-ranked task suggestions')
    .argument('<boardId>', 'Habitat UUID')
    .option('--limit <n>', 'Max suggestions', '5')
    .action(async (boardId: string, options: { limit: string }) => {
      const agentId = process.env.ORCY_AGENT_ID ?? '';
      const result = await api.get<any>(`/api/agents/${agentId}/suggestions?boardId=${encodeURIComponent(boardId)}&limit=${options.limit}`);
      console.log(JSON.stringify(result, null, 2));
    });
}
