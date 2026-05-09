import { api } from '../client.js';

export function registerWorktreeCommands(program: any) {
  const wt = program.command('worktree').description('Git worktree operations');

  wt.command('get-worktree')
    .description('Get git worktree info for a task')
    .argument('<taskId>', 'Task UUID')
    .action(async (taskId: string) => {
      const normId = taskId.startsWith('feat-') ? taskId.slice(5) : taskId;
      const result = await api.get<any>(`/api/tasks/${normId}/worktree`);
      console.log(JSON.stringify(result, null, 2));
    });
}
