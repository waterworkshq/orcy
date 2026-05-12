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

  const insights = pulse.command('insights').description('Project insights management');

  insights.command('list')
    .description('List project insights for a habitat')
    .argument('<boardId>', 'Board/habitat UUID')
    .option('--type <type>', 'Filter by signal type')
    .option('--limit <n>', 'Max insights', '20')
    .action(async (boardId: string, options: any) => {
      const params = new URLSearchParams();
      if (options.type) params.set('signalType', options.type);
      if (options.limit) params.set('limit', options.limit);
      const query = params.toString();

      try {
        const result = await api.get<any>(`/api/boards/${boardId}/insights${query ? `?${query}` : ''}`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to list insights: ${err.message}`);
        process.exit(1);
      }
    });

  insights.command('promote')
    .description('Promote a signal to a persistent project insight')
    .argument('<pulseId>', 'Pulse signal UUID to promote')
    .requiredOption('--board <boardId>', 'Board/habitat UUID')
    .option('--tags <tags>', 'Comma-separated relevance tags')
    .option('--subject <subject>', 'Override subject (defaults to source pulse)')
    .option('--body <body>', 'Override body (defaults to source pulse)')
    .action(async (pulseId: string, options: any) => {
      const body: Record<string, any> = { sourcePulseId: pulseId };
      if (options.tags) body.relevanceTags = options.tags.split(',');
      if (options.subject) body.subject = options.subject;
      if (options.body) body.body = options.body;

      try {
        const result = await api.post<any>(`/api/boards/${options.board}/insights`, body);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to promote insight: ${err.message}`);
        process.exit(1);
      }
    });

  insights.command('deactivate')
    .description('Deactivate a project insight')
    .argument('<insightId>', 'Insight UUID')
    .requiredOption('--board <boardId>', 'Board/habitat UUID')
    .action(async (insightId: string, options: any) => {
      try {
        const result = await api.delete<any>(`/api/boards/${options.board}/insights/${insightId}`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to deactivate insight: ${err.message}`);
        process.exit(1);
      }
    });
}
