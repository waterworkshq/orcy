import type { DaemonConfig, RegisteredAgent } from "./types.js";
import { DaemonApiClient } from "./api-client.js";
import { SessionManager } from "./session/manager.js";
import { WorkdirError } from "./workdir.js";

export interface PollLoopDeps {
  config: DaemonConfig;
  apiClient: DaemonApiClient;
  sessionManager: SessionManager;
  agents: RegisteredAgent[];
}

export class PollLoop {
  private config: DaemonConfig;
  private apiClient: DaemonApiClient;
  private sessionManager: SessionManager;
  private agents: RegisteredAgent[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: PollLoopDeps) {
    this.config = deps.config;
    this.apiClient = deps.apiClient;
    this.sessionManager = deps.sessionManager;
    this.agents = deps.agents;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.tick();

    this.timer = setInterval(() => this.tick(), this.config.pollIntervalSeconds * 1000);

    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      this.config.heartbeatIntervalSeconds * 1000,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async tick(): Promise<void> {
    if (!this.running) return;

    const idleAgents = this.getIdleAgents();
    if (idleAgents.length === 0) return;

    const availableSlots = this.config.maxConcurrent - this.sessionManager.activeCount;
    if (availableSlots <= 0) return;

    const toClaim = Math.min(idleAgents.length, availableSlots);

    for (let i = 0; i < toClaim; i++) {
      const agent = idleAgents[i];
      try {
        await this.tryClaimAndStart(agent);
      } catch {
        continue;
      }
    }
  }

  private getIdleAgents(): RegisteredAgent[] {
    const activeAgentIds = new Set(this.sessionManager.activeSessions.map((s) => s.agentId));
    return this.agents.filter((a) => !activeAgentIds.has(a.id));
  }

  private async tryClaimAndStart(agent: RegisteredAgent): Promise<void> {
    for (const habitatId of this.config.habitatIds) {
      try {
        const claim = await this.apiClient.claimNext(agent.id, habitatId);
        if (!claim) continue;

        try {
          await this.sessionManager.startSession(
            claim,
            agent.id,
            agent.apiKey,
            agent.type as any,
            agent.binPath ?? "",
          );
          return;
        } catch (err) {
          if (err instanceof WorkdirError) {
            continue;
          }
          throw err;
        }
      } catch {
        continue;
      }
    }
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const agentStatuses = this.agents.map((agent) => {
        const isActive = this.sessionManager.activeSessions.some((s) => s.agentId === agent.id);
        return {
          agentId: agent.id,
          status: isActive ? "working" : "idle",
        };
      });

      const activeSessions = this.sessionManager.activeSessions;
      const sessionProgresses = activeSessions.map((s) => ({
        sessionId: s.id,
        ...(s.lastProgress ? { lastProgress: s.lastProgress } : {}),
      }));

      await this.apiClient.heartbeat(agentStatuses, sessionProgresses);
    } catch {}
  }
}
