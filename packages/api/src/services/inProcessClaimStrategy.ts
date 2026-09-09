import type { IClaimStrategy, ClaimResult } from "@orcy/shared/types";

/** Function-handle dependencies for {@link InProcessClaimStrategy}: ownership checks, suggestion lookup, task claiming, and session creation — all executed in-process. */
export interface InProcessClaimDeps {
  daemonId: string;
  isAgentOwnedByDaemon(agentId: string, daemonId: string): boolean;
  getHabitatById(habitatId: string): { id: string; gitWorktreeSettings: unknown } | null;
  getSuggestionsForAgent(
    habitatId: string,
    agentId: string,
    limit: number,
  ): { suggestions: Array<{ taskId: string }> };
  /**
   * T1 atomic seam: claims the task AND creates the daemon session carrying
   * the claim's execution token in ONE transaction. Replaces the previous
   * claimTask + createDaemonSession pair (two separate writes, non-atomic).
   */
  claimTaskWithSession(
    taskId: string,
    input: {
      daemonId: string;
      agentId: string;
      taskId: string;
      habitatId: string;
      workdir: string;
    },
  ): { success: boolean; daemonSessionId?: string };
  getTaskById(taskId: string): {
    id: string;
    title: string;
    description: string | null;
    missionId: string;
    priority: string;
    requiredDomain: string | null;
    requiredCapabilities: string[] | null;
  } | null;
}

/** {@link IClaimStrategy} implementation for the API's embedded daemon. Claims tasks via direct service calls instead of HTTP — the in-process counterpart to `HttpClaimStrategy`. */
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
      const result = this.deps.claimTaskWithSession(suggestion.taskId, {
        daemonId: this.deps.daemonId,
        agentId,
        taskId: suggestion.taskId,
        habitatId,
        workdir: "pending",
      });
      if (result.success && result.daemonSessionId) {
        const task = this.deps.getTaskById(suggestion.taskId);
        if (!task) continue;

        return {
          daemonSessionId: result.daemonSessionId,
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
