import { hostname } from "node:os";
import type {
  DetectedCli,
  RegisteredAgent,
  ISessionManager,
  IClaimStrategy,
} from "@orcy/shared/types";
import { runPollTick } from "@orcy/shared";
import * as daemonRepo from "../repositories/daemon.js";
import * as agentService from "../services/agentService.js";
import * as taskService from "../services/tasks/index.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";
import { generateDaemonToken } from "../lib/daemonToken.js";
import {
  getSessionManager,
  getClaimStrategy,
  releaseSessionManager,
  detectClisOnHost,
} from "../daemon-wiring.js";
import { badRequest, forbidden } from "../errors.js";

interface RunningDaemon {
  daemonId: string;
  sessionManager: ISessionManager;
  claimStrategy: IClaimStrategy;
  agents: RegisteredAgent[];
  pollTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  habitatIds: string[];
  maxConcurrent: number;
}

const runningDaemons = new Map<string, RunningDaemon>();
const inMemoryAgentCredentials = new Map<string, RegisteredAgent[]>();

export interface RegisterResult {
  daemonId: string;
  agents: Array<{ id: string; name: string; type: string; apiKey: string }>;
}

export function register(
  name: string,
  habitatIds: string[],
  maxConcurrent: number = 4,
  cliPreferences?: string[],
): RegisterResult {
  for (const hid of habitatIds) {
    const h = habitatRepo.getHabitatById(hid);
    if (!h) {
      throw new Error(`Habitat ${hid} not found`);
    }
  }

  const detected = detectClisOnHost();
  const clis = cliPreferences
    ? detected.filter((c: DetectedCli) => cliPreferences.includes(c.type))
    : detected;

  const plainToken = generateDaemonToken();
  const daemon = daemonRepo.createDaemon({
    name,
    hostname: hostname(),
    maxConcurrent,
    daemonVersion: "in-process",
    plainToken,
    metadata: { habitatIds },
  });

  const agents: Array<{ id: string; name: string; type: string; apiKey: string }> = [];

  for (const cli of clis) {
    const agentName = `daemon-${name}-${cli.type}`;
    const created = agentService.createAgent({
      name: agentName,
      type: cli.type as any,
      domain: "fullstack",
      capabilities: [],
      metadata: { daemonId: daemon.id, cliPath: cli.path, cliVersion: cli.version },
    });

    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: created.agent.id,
      cliType: cli.type,
      cliVersion: cli.version ?? null,
      cliPath: cli.path,
    });

    agents.push({
      id: created.agent.id,
      name: created.agent.name,
      type: cli.type,
      apiKey: created.plainApiKey,
    });
  }

  inMemoryAgentCredentials.set(daemon.id, agents);

  return { daemonId: daemon.id, agents };
}

export function start(daemonId: string, dataDir: string = "/tmp/orcy-daemon"): void {
  const existing = runningDaemons.get(daemonId);
  if (existing) return;

  const daemon = daemonRepo.getDaemonById(daemonId);
  if (!daemon) {
    throw new Error(`Daemon ${daemonId} not found`);
  }

  const daemonAgents = daemonRepo.getDaemonAgentsByDaemonId(daemonId);
  const credentials = new Map((inMemoryAgentCredentials.get(daemonId) ?? []).map((a) => [a.id, a]));
  const agents: RegisteredAgent[] = daemonAgents.map((da) => ({
    id: da.agentId,
    name: `daemon-agent-${da.cliType}`,
    type: da.cliType as any,
    apiKey: credentials.get(da.agentId)?.apiKey ?? "",
    binPath: da.cliPath ?? undefined,
  }));

  if (agents.some((agent) => !agent.apiKey)) {
    throw new Error(
      "In-process daemon credentials are only available immediately after UI registration. Register a new UI daemon or use the standalone CLI daemon for persisted credentials.",
    );
  }

  const sessionManager = getSessionManager(daemonId, dataDir);
  const claimStrategy = getClaimStrategy({
    daemonId,
    isAgentOwnedByDaemon: (agentId, did) => daemonRepo.isAgentOwnedByDaemon(agentId, did),
    getHabitatById: (habitatId) => habitatRepo.getHabitatById(habitatId),
    getSuggestionsForAgent,
    claimTask: (taskId, agentId) => taskService.claimTask(taskId, agentId),
    getTaskById: (taskId) => taskRepo.getTaskById(taskId),
    createDaemonSession: (input) => daemonRepo.createDaemonSession(input),
  });

  const running: RunningDaemon = {
    daemonId,
    sessionManager,
    claimStrategy,
    agents,
    pollTimer: null,
    heartbeatTimer: null,
    habitatIds: [],
    maxConcurrent: daemon.maxConcurrent ?? 4,
  };

  const metadata = daemon.metadata ?? {};
  running.habitatIds = Array.isArray(metadata.habitatIds)
    ? metadata.habitatIds.filter((id): id is string => typeof id === "string")
    : [];

  daemonRepo.setDaemonStatus(daemonId, "online");
  daemonRepo.updateDaemonHeartbeat(daemonId);

  sessionManager.startTimeoutCheck();
  tick(running).catch(() => {});
  running.pollTimer = setInterval(() => tick(running), 30000);
  running.heartbeatTimer = setInterval(() => daemonRepo.updateDaemonHeartbeat(daemonId), 30000);

  runningDaemons.set(daemonId, running);
}

async function tick(running: RunningDaemon): Promise<void> {
  await runPollTick({
    sessionManager: running.sessionManager,
    agents: running.agents,
    habitatIds: running.habitatIds,
    maxConcurrent: running.maxConcurrent,
    claim: running.claimStrategy,
  });
}

export async function stop(daemonId: string): Promise<void> {
  const running = runningDaemons.get(daemonId);
  if (!running) return;

  if (running.pollTimer) {
    clearInterval(running.pollTimer);
  }
  if (running.heartbeatTimer) {
    clearInterval(running.heartbeatTimer);
  }

  await running.sessionManager.shutdownAll();
  daemonRepo.setDaemonStatus(daemonId, "offline");
  releaseSessionManager(daemonId);
  runningDaemons.delete(daemonId);
}

export { detectClisOnHost };

export function getRunningDaemon(daemonId: string): RunningDaemon | undefined {
  return runningDaemons.get(daemonId);
}

export function isRunning(daemonId: string): boolean {
  return runningDaemons.has(daemonId);
}

export function shutdownAll(): void {
  for (const [daemonId] of runningDaemons) {
    stop(daemonId).catch(() => {});
  }
}

export interface RegisterHttpDaemonInput {
  name: string;
  hostname: string;
  maxConcurrent: number;
  daemonVersion: string;
  habitatIds: string[];
  detectedClis: Array<{ type: string; path: string; version?: string | null }>;
}

export interface RegisterHttpDaemonResult {
  daemonId: string;
  daemonToken: string;
  heartbeatIntervalSeconds: number;
  agents: Array<{ id: string; name: string; type: string; apiKey: string }>;
}

export function registerHttpDaemon(input: RegisterHttpDaemonInput): RegisterHttpDaemonResult {
  for (const hid of input.habitatIds) {
    const h = habitatRepo.getHabitatById(hid);
    if (!h) {
      throw badRequest(`Habitat ${hid} not found`);
    }
  }

  const plainToken = generateDaemonToken();

  const daemon = daemonRepo.createDaemon({
    name: input.name,
    hostname: input.hostname,
    maxConcurrent: input.maxConcurrent,
    daemonVersion: input.daemonVersion,
    plainToken,
  });

  const agents: Array<{ id: string; name: string; type: string; apiKey: string }> = [];

  for (const cli of input.detectedClis) {
    const agentName = `daemon-${input.name}-${cli.type}`;
    const created = agentService.createAgent({
      name: agentName,
      type: cli.type as any,
      domain: "fullstack",
      capabilities: [],
      metadata: { daemonId: daemon.id, cliPath: cli.path, cliVersion: cli.version },
    });

    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: created.agent.id,
      cliType: cli.type,
      cliVersion: cli.version ?? null,
      cliPath: cli.path,
    });

    agents.push({
      id: created.agent.id,
      name: created.agent.name,
      type: cli.type,
      apiKey: created.plainApiKey,
    });
  }

  return {
    daemonId: daemon.id,
    daemonToken: plainToken,
    heartbeatIntervalSeconds: 30,
    agents,
  };
}

export interface ClaimNextDaemonTaskInput {
  daemonId: string;
  agentId: string;
  habitatId: string;
  maxConcurrent: number;
}

export type ClaimNextDaemonTaskResult =
  | {
      claimed: true;
      daemonSessionId: string;
      task: {
        id: string;
        title: string;
        description: string;
        missionId: string;
        habitatId: string;
        priority: string;
        requiredDomain: string | null;
        requiredCapabilities: string[];
      };
      worktreeSettings: unknown;
    }
  | { claimed: false };

export function claimNextDaemonTask(input: ClaimNextDaemonTaskInput): ClaimNextDaemonTaskResult {
  if (!daemonRepo.isAgentOwnedByDaemon(input.agentId, input.daemonId)) {
    throw forbidden("Agent does not belong to this daemon");
  }

  const habitat = habitatRepo.getHabitatById(input.habitatId);
  if (!habitat) {
    throw badRequest(`Habitat ${input.habitatId} not found`);
  }

  const activeSessions = daemonRepo.getActiveSessionsByDaemonId(input.daemonId);
  if (activeSessions.length >= input.maxConcurrent) {
    return { claimed: false };
  }

  if (activeSessions.some((session) => session.agentId === input.agentId)) {
    return { claimed: false };
  }

  const { suggestions } = getSuggestionsForAgent(input.habitatId, input.agentId, 10);

  for (const suggestion of suggestions) {
    const result = taskService.claimTask(suggestion.taskId, input.agentId);
    if (result.success) {
      const task = taskRepo.getTaskById(suggestion.taskId)!;

      const session = daemonRepo.createDaemonSession({
        daemonId: input.daemonId,
        agentId: input.agentId,
        taskId: task.id,
        habitatId: input.habitatId,
        workdir: "pending",
      });

      return {
        claimed: true,
        daemonSessionId: session.id,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          missionId: task.missionId,
          habitatId: input.habitatId,
          priority: task.priority,
          requiredDomain: task.requiredDomain,
          requiredCapabilities: task.requiredCapabilities,
        },
        worktreeSettings: habitat.gitWorktreeSettings,
      };
    }
  }

  return { claimed: false };
}
