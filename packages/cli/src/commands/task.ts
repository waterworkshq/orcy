import { api } from '../client.js';
import { normalizeTaskId } from '@orcy/shared';
import { withErrorHandling } from '../error-handler.js';

export function registerTaskCommands(program: any) {
  const task = program.command('task').description('Task operations');

  task.command('list-in-mission')
    .description('List all tasks within a mission')
    .argument('<missionId>', 'Mission UUID')
    .action(withErrorHandling(async (missionId: string) => {
      const result = await api.get<any>(`/api/missions/${missionId}/tasks`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('create-in-mission')
    .description('Create a task within a mission')
    .argument('<missionId>', 'Mission UUID')
    .argument('<title>', 'Task title')
    .option('--description <desc>', 'Task description')
    .option('--priority <priority>', 'Priority (low, medium, high, critical)')
    .option('--domain <domain>', 'Required agent domain (frontend, backend, devops, testing, fullstack)')
    .option('--capabilities <caps>', 'Comma-separated required capabilities')
    .option('--estimated-minutes <n>', 'Estimated time in minutes')
    .action(withErrorHandling(async (missionId: string, title: string, options: any) => {
      const body: Record<string, any> = { title };
      if (options.description) body.description = options.description;
      if (options.priority) body.priority = options.priority;
      if (options.domain) body.requiredDomain = options.domain;
      if (options.capabilities) body.requiredCapabilities = options.capabilities.split(',').map((s: string) => s.trim());
      if (options.estimatedMinutes) body.estimatedMinutes = Number(options.estimatedMinutes);
      const result = await api.post<any>(`/api/missions/${missionId}/tasks`, body);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('update')
    .description('Update task fields')
    .argument('<taskId>', 'Task UUID')
    .option('--title <title>', 'New title')
    .option('--description <desc>', 'New description')
    .option('--priority <priority>', 'New priority')
    .option('--domain <domain>', 'New required domain')
    .option('--capabilities <caps>', 'New comma-separated required capabilities')
    .option('--estimated-minutes <n>', 'New estimated minutes')
    .option('--version <n>', 'Optimistic locking version')
    .action(withErrorHandling(async (taskId: string, options: any) => {
      const body: Record<string, any> = {};
      if (options.title) body.title = options.title;
      if (options.description) body.description = options.description;
      if (options.priority) body.priority = options.priority;
      if (options.domain !== undefined) body.requiredDomain = options.domain;
      if (options.capabilities) body.requiredCapabilities = options.capabilities.split(',').map((s: string) => s.trim());
      if (options.estimatedMinutes !== undefined) body.estimatedMinutes = Number(options.estimatedMinutes);
      if (options.version !== undefined) body.version = Number(options.version);
      const normId = normalizeTaskId(taskId);
      const result = await api.patch<any>(`/api/tasks/${normId}`, body);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('delete')
    .description('Delete a task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      await api.delete(`/api/tasks/${normId}`);
      console.log(JSON.stringify({ success: true, taskId }, null, 2));
    }));

  task.command('claim')
    .description('Claim a task atomically')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/claim`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('start')
    .description('Start working on a claimed task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/start`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('submit')
    .description('Submit task for review')
    .argument('<taskId>', 'Task UUID')
    .option('--result <result>', 'Summary of what was accomplished')
    .option('--artifact-type <type>', 'Artifact type (pr, commit, file, screenshot, log)')
    .option('--artifact-url <url>', 'Artifact URL')
    .option('--artifact-desc <desc>', 'Artifact description')
    .action(withErrorHandling(async (taskId: string, options: any) => {
      const normId = normalizeTaskId(taskId);
      const artifacts: any[] = [];
      if (options.artifactType || options.artifactUrl) {
        artifacts.push({
          type: options.artifactType ?? 'file',
          url: options.artifactUrl ?? '',
          description: options.artifactDesc ?? '',
        });
      }
      const result = await api.post<any>(`/api/tasks/${normId}/submit`, {
        result: options.result ?? '',
        artifacts,
      });
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('complete')
    .description('Self-approve a submitted task (gated completion)')
    .argument('<taskId>', 'Task UUID')
    .option('--review-note <note>', 'Review note')
    .option('--artifact-type <type>', 'Artifact type')
    .option('--artifact-url <url>', 'Artifact URL')
    .option('--artifact-desc <desc>', 'Artifact description')
    .action(withErrorHandling(async (taskId: string, options: any) => {
      const normId = normalizeTaskId(taskId);
      const artifacts: any[] = [];
      if (options.artifactType || options.artifactUrl) {
        artifacts.push({
          type: options.artifactType ?? 'file',
          url: options.artifactUrl ?? '',
          description: options.artifactDesc ?? '',
        });
      }
      const result = await api.post<any>(`/api/tasks/${normId}/complete`, {
        reviewNote: options.reviewNote,
        artifacts,
      });
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('release')
    .description('Release a claimed task back to the pool')
    .argument('<taskId>', 'Task UUID')
    .option('--reason <reason>', 'Why the task is being released')
    .action(withErrorHandling(async (taskId: string, options: { reason?: string }) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/release`, { reason: options.reason ?? '' });
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('retry')
    .description('Retry a failed task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/retry`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('fail')
    .description('Mark a task as failed')
    .argument('<taskId>', 'Task UUID')
    .argument('<reason>', 'Why the task failed')
    .action(withErrorHandling(async (taskId: string, reason: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/fail`, { reason });
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-context')
    .description('Get full task context with feature and siblings')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-events')
    .description('Get task event history')
    .argument('<taskId>', 'Task UUID')
    .option('--limit <n>', 'Max events', '20')
    .option('--offset <n>', 'Events to skip', '0')
    .action(withErrorHandling(async (taskId: string, options: { limit: string; offset: string }) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/events?limit=${options.limit}&offset=${options.offset}`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-comments')
    .description('Get comments on a task')
    .argument('<taskId>', 'Task UUID')
    .option('--limit <n>', 'Max comments', '50')
    .option('--offset <n>', 'Comments to skip', '0')
    .action(withErrorHandling(async (taskId: string, options: { limit: string; offset: string }) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/comments?limit=${options.limit}&offset=${options.offset}`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('add-comment')
    .description('Add a comment to a task')
    .argument('<taskId>', 'Task UUID')
    .argument('<content>', 'Comment text')
    .option('--parent-id <id>', 'Parent comment UUID to reply to')
    .action(withErrorHandling(async (taskId: string, content: string, options: { parentId?: string }) => {
      const normId = normalizeTaskId(taskId);
      const body: Record<string, any> = { content };
      if (options.parentId) body.parentId = options.parentId;
      const result = await api.post<any>(`/api/tasks/${normId}/comments`, body);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-time-report')
    .description('Get time tracking report for a task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/time-report`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-blocked-status')
    .description('Check if a task is blocked by dependencies')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/blocked-status`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-approval-status')
    .description('Check if a task can be approved')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/approval-status`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('add-dependency')
    .description('Add a task dependency')
    .argument('<taskId>', 'Task UUID')
    .argument('<dependsOnTaskId>', 'UUID of the task that must be completed first')
    .action(withErrorHandling(async (taskId: string, dependsOnTaskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/dependencies`, { dependsOnTaskId });
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('remove-dependency')
    .description('Remove a task dependency')
    .argument('<taskId>', 'Task UUID')
    .argument('<dependencyTaskId>', 'UUID of the dependency to remove')
    .action(withErrorHandling(async (taskId: string, dependencyTaskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.delete<any>(`/api/tasks/${normId}/dependencies/${dependencyTaskId}`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('get-quality-checklist')
    .description('Get quality checklist for a task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/quality-checklist`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('update-quality-checklist-item')
    .description('Update a quality checklist item')
    .argument('<taskId>', 'Task UUID')
    .argument('<checklistId>', 'Checklist UUID')
    .argument('<itemId>', 'Item UUID')
    .option('--is-completed', 'Mark as completed')
    .option('--evidence-url <url>', 'Evidence URL')
    .option('--notes <notes>', 'Notes')
    .action(withErrorHandling(async (taskId: string, checklistId: string, itemId: string, options: any) => {
      const normId = normalizeTaskId(taskId);
      const body: Record<string, any> = {};
      if (options.isCompleted !== undefined) body.isCompleted = true;
      if (options.evidenceUrl) body.evidenceUrl = options.evidenceUrl;
      if (options.notes) body.notes = options.notes;
      const result = await api.put<any>(`/api/tasks/${normId}/quality-checklist/${checklistId}/items/${itemId}`, body);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('validate-quality-gates')
    .description('Validate all quality gates for a task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.post<any>(`/api/tasks/${normId}/quality-checklist/validate`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('list-subtasks')
    .description('List all subtasks for a task')
    .argument('<taskId>', 'Task UUID')
    .action(withErrorHandling(async (taskId: string) => {
      const normId = normalizeTaskId(taskId);
      const result = await api.get<any>(`/api/tasks/${normId}/subtasks`);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('create-subtask')
    .description('Create a subtask')
    .argument('<taskId>', 'Task UUID')
    .argument('<title>', 'Subtask title')
    .option('--assignee-id <id>', 'Agent UUID to assign to')
    .action(withErrorHandling(async (taskId: string, title: string, options: { assigneeId?: string }) => {
      const normId = normalizeTaskId(taskId);
      const body: Record<string, any> = { title };
      if (options.assigneeId) body.assigneeId = options.assigneeId;
      const result = await api.post<any>(`/api/tasks/${normId}/subtasks`, body);
      console.log(JSON.stringify(result, null, 2));
    }));

  task.command('delete-subtask')
    .description('Delete a subtask')
    .argument('<taskId>', 'Task UUID')
    .argument('<subtaskId>', 'Subtask UUID')
    .action(withErrorHandling(async (taskId: string, subtaskId: string) => {
      const normId = normalizeTaskId(taskId);
      await api.delete(`/api/tasks/${normId}/subtasks/${subtaskId}`);
      console.log(JSON.stringify({ success: true }, null, 2));
    }));
}
