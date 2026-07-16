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
import * as habitatRepo from "../repositories/habitat.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";
import { generateDaemonToken } from "../lib/daemonToken.js";
import { logger } from "../lib/logger.js";
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

/** Result of registering an in-process daemon: the daemon id and the per-agent credentials (including one-time API keys) for each detected CLI. */
export interface RegisterResult {
  daemonId: string;
  agents: Array<{ id: string; name: string; type: string; apiKey: string }>;
}

/**
 * Registers a new in-process UI daemon and creates one agent per detected CLI, returning a {@link RegisterResult} whose `apiKey` values are kept in memory and are only retrievable immediately after registration.
 */
export function register(
  name: string,
  habitatIds: string[],
  maxConcurrent: number = 4,
  cliPreferences?: string[],
): RegisterResult {
  for (const hid of habitatIds) {
    const h = habitatRepo.getHabitatById(hid);
    if (!h) {
      throw badRequest(`Habitat ${hid} not found`);
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

/**
 * Starts the in-process poll loop and heartbeat timer for a previously-registered daemon, flipping its status to "online" and handing work to the configured {@link IClaimStrategy}; no-op if the daemon is already running.
 */
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
  tick(running).catch((err) => logger.warn({ err, daemonId: running.daemonId }, "Daemon poll tick failed"));
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

/**
 * Stops a running in-process daemon by clearing its poll/heartbeat timers, shutting down every active session, releasing its {@link ISessionManager}, and marking it "offline"; no-op if the daemon is not running.
 */
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

/**
 * Returns the in-memory running record for `daemonId`, or `undefined` if it has not been started.
 */
export function getRunningDaemon(daemonId: string): RunningDaemon | undefined {
  return runningDaemons.get(daemonId);
}

/**
 * Returns whether a daemon currently has an active in-process poll loop.
 */
export function isRunning(daemonId: string): boolean {
  return runningDaemons.has(daemonId);
}

/**
 * Stops every running in-process daemon concurrently (fire-and-forget), intended as a process-exit hook to release all held sessions.
 */
export function shutdownAll(): void {
  for (const [daemonId] of runningDaemons) {
    stop(daemonId).catch(() => {});
  }
}

/** Input for HTTP-based daemon registration: daemon identity, concurrency limit, target habitats, and the CLIs detected on the remote host. */
export interface RegisterHttpDaemonInput {
  name: string;
  hostname: string;
  maxConcurrent: number;
  daemonVersion: string;
  habitatIds: string[];
  detectedClis: Array<{ type: string; path: string; version?: string | null }>;
}

/** Result of HTTP-based daemon registration: the daemon id, the one-time daemon token, the heartbeat cadence, and per-agent credentials to deliver out-of-band. */
export interface RegisterHttpDaemonResult {
  daemonId: string;
  daemonToken: string;
  heartbeatIntervalSeconds: number;
  agents: Array<{ id: string; name: string; type: string; apiKey: string }>;
}

/**
 * Registers a daemon via the HTTP API with one agent per supplied CLI in `detectedClis`, returning a {@link RegisterHttpDaemonResult} that includes the daemon token and per-agent API keys for the caller to deliver out-of-band.
 */
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

/** Input for claiming the next daemon task: the daemon, agent, and habitat involved plus the concurrency ceiling to enforce. */
export interface ClaimNextDaemonTaskInput {
  daemonId: string;
  agentId: string;
  habitatId: string;
  maxConcurrent: number;
}

/** Discriminated result of a claim attempt: either a claimed task with its session id and worktree settings, or `{ claimed: false }` when the daemon is at capacity, the agent is busy, or no task is available. */
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

/**
 * Claims the next available task for an agent on a given daemon and habitat, returning a {@link ClaimNextDaemonTaskResult} that is `{ claimed: false }` when the daemon is at capacity, the agent is already busy, or no suggestion can be claimed, and throwing `forbidden`/`badRequest` if the agent or habitat is invalid.
 */
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
