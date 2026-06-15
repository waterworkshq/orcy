import { api } from "../client.js";
import { normalizeTaskId } from "@orcy/shared";
import { withErrorHandling } from "../error-handler.js";

/** Registers the `orcy worktree` subcommands (get-worktree) on the given {@link Command}. */
export function registerWorktreeCommands(program: any) {
  const wt = program.command("worktree").description("Git worktree operations");

  wt.command("get-worktree")
    .description("Get git worktree info for a task")
    .argument("<taskId>", "Task UUID")
    .action(
      withErrorHandling(async (taskId: string) => {
        const normId = normalizeTaskId(taskId);
        const result = await api.get<any>(`/api/tasks/${normId}/worktree`);
        console.log(JSON.stringify(result, null, 2));
      }),
    );
}
