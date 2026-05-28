import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { ActiveSession, SessionStatus, ClaimResult, CliType } from "../types.js";
import { spawnCli, terminateProcess, type SpawnedProcess } from "./spawner.js";
import { getAdapter } from "./adapters.js";
import { validateWorktreeConfig, createWorkdir } from "../workdir.js";
import { WorkdirError } from "../workdir.js";
import { DaemonApiClient } from "../api-client.js";
import { redact } from "../redact.js";

interface ManagerDeps {
  apiClient: DaemonApiClient;
  apiUrl: string;
  dataDir: string;
  sessionTimeoutSeconds: number;
  onSessionComplete?: (session: ActiveSession) => void;
}

export class SessionManager {
  private sessions: Map<string, ActiveSession> = new Map();
  private children: Map<string, ChildProcess> = new Map();
  private apiClient: DaemonApiClient;
  private apiUrl: string;
  private dataDir: string;
  private sessionTimeoutSeconds: number;
  private onSessionComplete?: (session: ActiveSession) => void;
  private timeoutTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ManagerDeps) {
    this.apiClient = deps.apiClient;
    this.apiUrl = deps.apiUrl;
    this.dataDir = deps.dataDir;
    this.sessionTimeoutSeconds = deps.sessionTimeoutSeconds;
    this.onSessionComplete = deps.onSessionComplete;
  }

  get activeCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "starting" || s.status === "running") count++;
    }
    return count;
  }

  get activeSessions(): ActiveSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.status === "starting" || s.status === "running",
    );
  }

  getSession(id: string): ActiveSession | undefined {
    return this.sessions.get(id);
  }

  startTimeoutCheck(): void {
    if (this.timeoutTimer) return;
    this.timeoutTimer = setInterval(() => this.checkTimeouts(), this.sessionTimeoutSeconds * 1000);
  }

  stopTimeoutCheck(): void {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  async startSession(
    claim: ClaimResult,
    agentId: string,
    agentApiKey: string,
    agentType: CliType,
    agentBinPath: string,
    daemonSessionId?: string,
  ): Promise<ActiveSession> {
    const validationError = validateWorktreeConfig(claim);
    if (validationError) {
      throw new WorkdirError(`Cannot start session: ${validationError}`);
    }

    let workdirResult;
    try {
      workdirResult = createWorkdir(claim, this.dataDir);
    } catch (err) {
      throw new WorkdirError(
        `Workdir creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sessionId = daemonSessionId ?? randomUUID();
    const now = Date.now();

    const session: ActiveSession = {
      id: sessionId,
      taskId: claim.task.id,
      taskTitle: claim.task.title,
      agentId,
      agentApiKey,
      agentType,
      agentBinPath,
      habitatId: claim.task.habitatId,
      workdir: workdirResult.path,
      status: "starting",
      pid: null,
      startedAt: now,
      lastProgressAt: now,
      lastProgress: null,
    };

    this.sessions.set(sessionId, session);

    try {
      const spawned = spawnCli(
        agentType,
        claim.task.id,
        claim.task.title,
        workdirResult.path,
        agentId,
        agentApiKey,
        this.apiUrl,
        agentBinPath,
        {
          onStdout: (data) => this.handleOutput(sessionId, data),
          onStderr: (data) => this.handleOutput(sessionId, data),
          onExit: (code, signal) => this.handleExit(sessionId, code, signal),
        },
      );

      session.pid = spawned.pid;
      session.status = "running";
      this.children.set(sessionId, spawned.child);

      if (daemonSessionId) {
        await this.apiClient.updateSession(daemonSessionId, {
          status: "running",
          pid: spawned.pid,
          workdir: workdirResult.path,
        });
      }
    } catch (err) {
      session.status = "failed";
      if (daemonSessionId) {
        await this.apiClient.updateSession(daemonSessionId, {
          status: "failed",
          lastProgress: redact(err instanceof Error ? err.message : String(err)),
        });
      }
      throw err;
    }

    return session;
  }

  async terminateSession(sessionId: string): Promise<boolean> {
    const child = this.children.get(sessionId);
    if (!child) return false;

    return terminateProcess(child);
  }

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.terminateSession(sessionId);
    session.status = "released";
    this.children.delete(sessionId);

    try {
      await this.apiClient.updateSession(sessionId, { status: "released" });
    } catch {}
  }

  async shutdownAll(): Promise<void> {
    this.stopTimeoutCheck();

    const activeIds = [...this.sessions.keys()].filter((id) => {
      const s = this.sessions.get(id)!;
      return s.status === "starting" || s.status === "running";
    });

    for (const id of activeIds) {
      const session = this.sessions.get(id)!;
      const adapter = getAdapter(session.agentType);
      if (adapter.supportsResume(null)) {
        await this.releaseSession(id);
      } else {
        await this.failSession(id, "Daemon shutdown: CLI does not support session resume");
      }
    }
  }

  private async failSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.terminateSession(sessionId);
    session.status = "failed";
    this.children.delete(sessionId);

    try {
      await this.apiClient.updateSession(sessionId, {
        status: "failed",
        lastProgress: reason,
      });
    } catch {}
  }

  private checkTimeouts(): void {
    const now = Date.now();
    const timeoutMs = this.sessionTimeoutSeconds * 1000;

    for (const [sessionId, session] of this.sessions) {
      if (session.status !== "running" && session.status !== "starting") continue;
      if (now - session.lastProgressAt < timeoutMs) continue;

      const child = this.children.get(sessionId);
      if (child) {
        terminateProcess(child);
      }
      session.status = "failed";
      this.children.delete(sessionId);

      this.apiClient
        .updateSession(sessionId, {
          status: "failed",
          lastProgress: `Session timed out after ${this.sessionTimeoutSeconds}s of inactivity`,
        })
        .then(
          () => {},
          () => {},
        );

      this.onSessionComplete?.(session);
    }
  }

  private handleOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const adapter = getAdapter(session.agentType);
    const parsed = adapter.parseOutput(data);
    if (parsed) {
      session.lastProgress = parsed;
      session.lastProgressAt = Date.now();
    }
  }

  private async handleExit(
    sessionId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.children.delete(sessionId);

    let newStatus: SessionStatus;
    if (code === 0) {
      newStatus = "completed";
    } else if (signal) {
      newStatus = "lost";
    } else {
      newStatus = "failed";
    }

    session.status = newStatus;

    try {
      await this.apiClient.updateSession(sessionId, {
        status: newStatus,
        lastProgress: session.lastProgress,
      });
    } catch {}

    this.onSessionComplete?.(session);
  }
}
