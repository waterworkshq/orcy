import { hostname } from "node:os";
import { SessionManager } from "@orcy/daemon";
import { detectClis } from "@orcy/daemon";
import type { DetectedCli, RegisteredAgent, ClaimResult } from "@orcy/daemon";
import * as daemonRepo from "../repositories/daemon.js";
import * as agentService from "../services/agentService.js";
import * as taskService from "../services/tasks/index.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";
import { generateDaemonToken } from "../lib/daemonToken.js";
import { InProcessSessionUpdater } from "./inProcessSessionUpdater.js";

interface RunningDaemon {
  daemonId: string;
  sessionManager: SessionManager;
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

  const detected = detectClis();
  const clis = cliPreferences ? detected.filter((c) => cliPreferences.includes(c.type)) : detected;

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

  const sessionUpdater = new InProcessSessionUpdater();

  const sessionManager = new SessionManager({
    sessionUpdater,
    apiUrl: "",
    dataDir,
    sessionTimeoutSeconds: 600,
  });

  const running: RunningDaemon = {
    daemonId,
    sessionManager,
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
  const idleAgents = getIdleAgents(running);
  if (idleAgents.length === 0) return;

  const availableSlots = running.maxConcurrent - running.sessionManager.activeCount;
  if (availableSlots <= 0) return;

  const toClaim = Math.min(idleAgents.length, availableSlots);

  for (let i = 0; i < toClaim; i++) {
    try {
      await tryClaimAndStart(running, idleAgents[i]);
    } catch {
      continue;
    }
  }
}

function getIdleAgents(running: RunningDaemon): RegisteredAgent[] {
  const activeAgentIds = new Set(running.sessionManager.activeSessions.map((s) => s.agentId));
  return running.agents.filter((a) => !activeAgentIds.has(a.id));
}

async function tryClaimAndStart(running: RunningDaemon, agent: RegisteredAgent): Promise<void> {
  for (const habitatId of running.habitatIds) {
    const claim = claimNextForAgent(agent.id, habitatId, running.daemonId);
    if (!claim) continue;

    try {
      await running.sessionManager.startSession(
        claim,
        agent.id,
        agent.apiKey,
        agent.type as any,
        agent.binPath ?? "",
        claim.daemonSessionId,
      );
      return;
    } catch {
      continue;
    }
  }
}

function claimNextForAgent(
  agentId: string,
  habitatId: string,
  daemonId: string,
): ClaimResult | null {
  if (!daemonRepo.isAgentOwnedByDaemon(agentId, daemonId)) return null;

  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return null;

  const { suggestions } = getSuggestionsForAgent(habitatId, agentId, 10);

  for (const suggestion of suggestions) {
    const result = taskService.claimTask(suggestion.taskId, agentId);
    if (result.success) {
      const task = taskRepo.getTaskById(suggestion.taskId)!;

      const session = daemonRepo.createDaemonSession({
        daemonId,
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
        worktreeSettings: habitat.gitWorktreeSettings,
      };
    }
  }

  return null;
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
  runningDaemons.delete(daemonId);
}

export function detectClisOnHost(): DetectedCli[] {
  return detectClis();
}

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
