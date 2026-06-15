import type { IHeartbeatStrategy, RegisteredAgent, ActiveSession } from "@orcy/shared/types";
import type { DaemonApiClient } from "./api-client.js";

/** {@link IHeartbeatStrategy} implementation that posts agent statuses and session progress to the daemon HTTP API. Used by the standalone daemon's `PollLoop`. */
export class HttpHeartbeatStrategy implements IHeartbeatStrategy {
  constructor(private apiClient: DaemonApiClient) {}

  async sendHeartbeat(
    _daemonId: string,
    agents: ReadonlyArray<RegisteredAgent>,
    activeSessions: ReadonlyArray<ActiveSession>,
  ): Promise<void> {
    const agentStatuses = agents.map((agent) => {
      const isActive = activeSessions.some((s) => s.agentId === agent.id);
      return {
        agentId: agent.id,
        status: isActive ? "working" : "idle",
      };
    });

    const sessionProgresses = activeSessions.map((s) => ({
      sessionId: s.id,
      ...(s.lastProgress ? { lastProgress: s.lastProgress } : {}),
    }));

    await this.apiClient.heartbeat(agentStatuses, sessionProgresses);
  }
}
