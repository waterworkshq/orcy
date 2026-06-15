import type { IClaimStrategy, ClaimResult } from "@orcy/shared/types";

export interface InProcessClaimDeps {
  daemonId: string;
  isAgentOwnedByDaemon(agentId: string, daemonId: string): boolean;
  getHabitatById(habitatId: string): { id: string; gitWorktreeSettings: unknown } | null;
  getSuggestionsForAgent(
    habitatId: string,
    agentId: string,
    limit: number,
  ): { suggestions: Array<{ taskId: string }> };
  claimTask(taskId: string, agentId: string): { success: boolean };
  getTaskById(taskId: string): {
    id: string;
    title: string;
    description: string | null;
    missionId: string;
    priority: string;
    requiredDomain: string | null;
    requiredCapabilities: string[] | null;
  } | null;
  createDaemonSession(input: {
    daemonId: string;
    agentId: string;
    taskId: string;
    habitatId: string;
    workdir: string;
  }): { id: string };
}

export class InProcessClaimStrategy implements IClaimStrategy {
  constructor(private deps: InProcessClaimDeps) {}

  async claimNext(
    agentId: string,
    habitatId: string,
    _daemonId: string,
  ): Promise<ClaimResult | null> {
    if (!this.deps.isAgentOwnedByDaemon(agentId, this.deps.daemonId)) return null;

    const habitat = this.deps.getHabitatById(habitatId);
    if (!habitat) return null;

    const { suggestions } = this.deps.getSuggestionsForAgent(habitatId, agentId, 10);

    for (const suggestion of suggestions) {
      const result = this.deps.claimTask(suggestion.taskId, agentId);
      if (result.success) {
        const task = this.deps.getTaskById(suggestion.taskId);
        if (!task) continue;

        const session = this.deps.createDaemonSession({
          daemonId: this.deps.daemonId,
          agentId,
          taskId: task.id,
          habitatId,
          workdir: "pending",
        });

        return {
          daemonSessionId: session.id,
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            missionId: task.missionId,
            habitatId,
            priority: task.priority,
            requiredDomain: task.requiredDomain,
            requiredCapabilities: task.requiredCapabilities,
          },
          worktreeSettings: habitat.gitWorktreeSettings as ClaimResult["worktreeSettings"],
        };
      }
    }

    return null;
  }
}
