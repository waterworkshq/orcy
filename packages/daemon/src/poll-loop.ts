import type { DaemonConfig, RegisteredAgent } from "./types.js";
import type { IClaimStrategy, IHeartbeatStrategy, ISessionManager } from "@orcy/shared/types";
import { runPollTick } from "@orcy/shared";
import { DaemonApiClient } from "./api-client.js";
import { SessionManager } from "./session/manager.js";
import { HttpClaimStrategy } from "./httpClaimStrategy.js";
import { HttpHeartbeatStrategy } from "./httpHeartbeatStrategy.js";

export interface PollLoopDeps {
  config: DaemonConfig;
  apiClient: DaemonApiClient;
  sessionManager: SessionManager;
  agents: RegisteredAgent[];
  claimStrategy?: IClaimStrategy;
  heartbeatStrategy?: IHeartbeatStrategy;
}

export class PollLoop {
  private config: DaemonConfig;
  private sessionManager: ISessionManager;
  private agents: RegisteredAgent[];
  private claimStrategy: IClaimStrategy;
  private heartbeatStrategy: IHeartbeatStrategy;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: PollLoopDeps) {
    this.config = deps.config;
    this.sessionManager = deps.sessionManager;
    this.agents = deps.agents;
    this.claimStrategy = deps.claimStrategy ?? new HttpClaimStrategy(deps.apiClient);
    this.heartbeatStrategy = deps.heartbeatStrategy ?? new HttpHeartbeatStrategy(deps.apiClient);
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
    await runPollTick({
      sessionManager: this.sessionManager,
      agents: this.agents,
      habitatIds: this.config.habitatIds,
      maxConcurrent: this.config.maxConcurrent,
      claim: this.claimStrategy,
    });
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await this.heartbeatStrategy.sendHeartbeat(
        "",
        this.agents,
        this.sessionManager.activeSessions,
      );
    } catch {}
  }
}
