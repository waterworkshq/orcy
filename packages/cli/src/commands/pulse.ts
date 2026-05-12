import { api } from '../client.js';

const VALID_SIGNAL_TYPES = [
  'finding', 'blocker', 'offer', 'warning',
  'question', 'answer', 'directive', 'context', 'handoff',
];

export function registerPulseCommands(program: any) {
  const pulse = program.command('pulse').description('Mission Pulse signal operations');

  pulse.command('post')
    .description('Post a signal to a mission or habitat pulse board')
    .argument('[missionId]', 'Mission UUID (omit when using --habitat)')
    .requiredOption('--type <type>', `Signal type: ${VALID_SIGNAL_TYPES.join(', ')}`)
    .requiredOption('--subject <subject>', 'Signal subject line')
    .option('--body <body>', 'Signal body/details')
    .option('--to <agentName>', 'Target agent name')
    .option('--reply-to <pulseId>', 'Reply to a signal')
    .option('--task-id <taskId>', 'Related task UUID')
    .option('--habitat <boardId>', 'Post to habitat board instead of mission')
    .action(async (missionId: string | undefined, options: any) => {
      if (!VALID_SIGNAL_TYPES.includes(options.type)) {
        console.error(`Invalid signal type. Must be one of: ${VALID_SIGNAL_TYPES.join(', ')}`);
        process.exit(1);
      }

      const body: Record<string, any> = {
        signalType: options.type,
        subject: options.subject,
      };
      if (options.body) body.body = options.body;
      if (options.to) body.toAgentName = options.to;
      if (options.replyTo) body.replyToId = options.replyTo;
      if (options.taskId) body.taskId = options.taskId;

      try {
        if (options.habitat) {
          const result = await api.post<any>(`/api/boards/${options.habitat}/pulse`, body);
          console.log(JSON.stringify(result, null, 2));
        } else if (missionId) {
          const result = await api.post<any>(`/api/missions/${missionId}/pulse`, body);
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.error('Provide a missionId or use --habitat <boardId>');
          process.exit(1);
        }
      } catch (err: any) {
        console.error(`Failed to post signal: ${err.message}`);
        process.exit(1);
      }
    });

  pulse.command('list')
    .description('List signals on a mission or habitat pulse board')
    .argument('[missionId]', 'Mission UUID (omit when using --habitat)')
    .option('--type <type>', 'Filter by signal type')
    .option('--habitat <boardId>', 'List habitat board signals')
    .option('--limit <n>', 'Max signals', '20')
    .action(async (missionId: string | undefined, options: any) => {
      if (options.type && !VALID_SIGNAL_TYPES.includes(options.type)) {
        console.error(`Invalid signal type. Must be one of: ${VALID_SIGNAL_TYPES.join(', ')}`);
        process.exit(1);
      }
      const params = new URLSearchParams();
      if (options.type) params.set('signalType', options.type);
      if (options.limit) params.set('limit', options.limit);
      const query = params.toString();

      try {
        if (options.habitat) {
          const result = await api.get<any>(`/api/boards/${options.habitat}/pulse${query ? `?${query}` : ''}`);
          console.log(JSON.stringify(result, null, 2));
        } else if (missionId) {
          const result = await api.get<any>(`/api/missions/${missionId}/pulse${query ? `?${query}` : ''}`);
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.error('Provide a missionId or use --habitat <boardId>');
          process.exit(1);
        }
      } catch (err: any) {
        console.error(`Failed to list signals: ${err.message}`);
        process.exit(1);
      }
    });

  pulse.command('inbox')
    .description('List signals across all missions targeted at you')
    .option('--type <type>', 'Filter by signal type')
    .option('--limit <n>', 'Max signals', '20')
    .action(async (options: any) => {
      if (options.type && !VALID_SIGNAL_TYPES.includes(options.type)) {
        console.error(`Invalid signal type. Must be one of: ${VALID_SIGNAL_TYPES.join(', ')}`);
        process.exit(1);
      }
      const params = new URLSearchParams();
      if (options.type) params.set('signalType', options.type);
      if (options.limit) params.set('limit', options.limit);
      const query = params.toString();

      try {
        const result = await api.get<any>(`/api/pulse/inbox${query ? `?${query}` : ''}`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to fetch inbox: ${err.message}`);
        process.exit(1);
      }
    });
}
