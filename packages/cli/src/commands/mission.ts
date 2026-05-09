import { api } from '../client.js';

export function registerMissionCommands(program: any) {
  const mission = program.command('mission').description('Mission operations');

  mission.command('list')
    .description('List missions on a habitat')
    .argument('<habitatId>', 'Habitat UUID')
    .option('--status <status>', 'Filter by status (not_started, in_progress, review, done, failed)')
    .option('--priority <priority>', 'Filter by priority (low, medium, high, critical)')
    .option('--is-archived', 'List archived missions instead of active')
    .option('--limit <n>', 'Max results', '20')
    .action(async (habitatId: string, options: { status?: string; priority?: string; isArchived?: boolean; limit: string }) => {
      const params = new URLSearchParams();
      if (options.status) params.set('status', options.status);
      if (options.priority) params.set('priority', options.priority);
      if (options.isArchived) params.set('isArchived', 'true');
      params.set('limit', options.limit);
      const qs = params.toString();
      const result = await api.get<any>(`/api/boards/${habitatId}/features${qs ? `?${qs}` : ''}`);
      console.log(JSON.stringify(result, null, 2));
    });

  mission.command('create')
    .description('Create a new mission on a habitat')
    .argument('<habitatId>', 'Habitat UUID')
    .argument('<title>', 'Mission title')
    .option('--description <desc>', 'Mission description')
    .option('--acceptance-criteria <ac>', 'Acceptance criteria')
    .option('--priority <priority>', 'Priority (low, medium, high, critical)')
    .option('--labels <labels>', 'Comma-separated labels')
    .option('--depends-on <ids>', 'Comma-separated mission IDs this depends on')
    .option('--due-at <iso>', 'ISO 8601 deadline')
    .option('--sla-minutes <n>', 'SLA in minutes')
    .action(async (habitatId: string, title: string, options: any) => {
      const body: Record<string, any> = { title };
      if (options.description) body.description = options.description;
      if (options.acceptanceCriteria) body.acceptanceCriteria = options.acceptanceCriteria;
      if (options.priority) body.priority = options.priority;
      if (options.labels) body.labels = options.labels.split(',').map((s: string) => s.trim());
      if (options.dependsOn) body.dependsOn = options.dependsOn.split(',').map((s: string) => s.trim());
      if (options.dueAt) body.dueAt = options.dueAt;
      if (options.slaMinutes) body.slaMinutes = Number(options.slaMinutes);
      const result = await api.post<any>(`/api/boards/${habitatId}/features`, body);
      console.log(JSON.stringify(result, null, 2));
    });

  mission.command('delete')
    .description('Delete a mission and all its tasks')
    .argument('<missionId>', 'Mission UUID')
    .action(async (missionId: string) => {
      await api.delete(`/api/features/${missionId}`);
      console.log(JSON.stringify({ success: true, missionId }, null, 2));
    });

  mission.command('archive')
    .description('Archive a completed mission')
    .argument('<missionId>', 'Mission UUID')
    .action(async (missionId: string) => {
      const result = await api.post<any>(`/api/features/${missionId}/archive`);
      console.log(JSON.stringify(result, null, 2));
    });

  mission.command('unarchive')
    .description('Unarchive a previously archived mission')
    .argument('<missionId>', 'Mission UUID')
    .action(async (missionId: string) => {
      const result = await api.post<any>(`/api/features/${missionId}/unarchive`);
      console.log(JSON.stringify(result, null, 2));
    });

  mission.command('get-context')
    .description('Get full mission context with tasks and dependencies')
    .argument('<missionId>', 'Mission UUID')
    .action(async (missionId: string) => {
      const result = await api.get<any>(`/api/features/${missionId}/details`);
      console.log(JSON.stringify(result, null, 2));
    });
}
