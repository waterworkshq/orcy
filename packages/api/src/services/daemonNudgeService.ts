import * as daemonRepo from "../repositories/daemon.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";

const NUDGE_DEBOUNCE_MS = 5 * 60 * 1000;
const lastNudgeByHabitat = new Map<string, number>();

export interface NudgeResult {
  habitatId: string;
  pulseId: string | null;
  reason: string;
}

export function nudgeAllDaemons(): NudgeResult[] {
  const results: NudgeResult[] = [];
  const now = Date.now();

  const daemons = daemonRepo.listDaemons().filter((d) => d.status === "online");
  if (daemons.length === 0) return results;

  const idleAgents: Array<{ agentId: string; daemonId: string; cliType: string }> = [];
  for (const daemon of daemons) {
    const agents = daemonRepo.getDaemonAgentsByDaemonId(daemon.id);
    for (const agent of agents) {
      if (agent.status === "idle") {
        idleAgents.push({ agentId: agent.agentId, daemonId: daemon.id, cliType: agent.cliType });
      }
    }
  }
  if (idleAgents.length === 0) return results;

  const habitats = habitatRepo.listHabitats();

  for (const habitat of habitats) {
    const lastNudge = lastNudgeByHabitat.get(habitat.id) ?? 0;
    if (now - lastNudge < NUDGE_DEBOUNCE_MS) {
      results.push({ habitatId: habitat.id, pulseId: null, reason: "debounced" });
      continue;
    }

    const available = taskRepo.getAvailableTasksForAgent(habitat.id, "fullstack", {
      status: "pending",
      limit: 1,
    });

    if (available.length === 0) {
      results.push({ habitatId: habitat.id, pulseId: null, reason: "no pending tasks" });
      continue;
    }

    const pendingCount = taskRepo.getTasksByHabitatId(habitat.id, { status: "pending" }).total;

    try {
      const pulse = pulseRepo.createPulse({
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "system",
        fromId: "scheduler",
        signalType: "directive",
        subject: `${pendingCount} pending task${pendingCount !== 1 ? "s" : ""} available for idle agents`,
        body: `${idleAgents.length} idle daemon agent${idleAgents.length !== 1 ? "s" : ""} detected. ${pendingCount} pending task${pendingCount !== 1 ? "s" : ""} in ${habitat.name}.`,
        metadata: {
          nudgeType: "idle_check",
          idleAgentCount: idleAgents.length,
          pendingTaskCount: pendingCount,
        },
        isAuto: true,
      });

      lastNudgeByHabitat.set(habitat.id, now);
      results.push({ habitatId: habitat.id, pulseId: pulse.id, reason: "nudged" });
    } catch (err) {
      results.push({ habitatId: habitat.id, pulseId: null, reason: `error: ${err}` });
    }
  }

  return results;
}

export function resetDebounce(habitatId?: string): void {
  if (habitatId) {
    lastNudgeByHabitat.delete(habitatId);
  } else {
    lastNudgeByHabitat.clear();
  }
}

export function getLastNudgeTimes(): ReadonlyMap<string, number> {
  return lastNudgeByHabitat;
}
