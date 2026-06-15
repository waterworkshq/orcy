import type {
  ISessionManager,
  IClaimStrategy,
  RegisteredAgent,
  ClaimResult,
  CliType,
} from "./types/daemon.js";
import { WorkdirError } from "./workdir-error.js";

export interface PollTickDeps {
  sessionManager: ISessionManager;
  agents: ReadonlyArray<RegisteredAgent>;
  habitatIds: ReadonlyArray<string>;
  maxConcurrent: number;
  claim: IClaimStrategy;
}

export interface PollTickResult {
  idleAgentCount: number;
  availableSlots: number;
  claimed: number;
  failed: number;
  errorsByKind: { claim: number; workdir: number; other: number };
}

export async function runPollTick(deps: PollTickDeps): Promise<PollTickResult> {
  const activeAgentIds = new Set(deps.sessionManager.activeSessions.map((s) => s.agentId));
  const idleAgents = deps.agents.filter((a) => !activeAgentIds.has(a.id));
  if (idleAgents.length === 0) {
    return {
      idleAgentCount: 0,
      availableSlots: 0,
      claimed: 0,
      failed: 0,
      errorsByKind: { claim: 0, workdir: 0, other: 0 },
    };
  }

  const availableSlots = deps.maxConcurrent - deps.sessionManager.activeCount;
  if (availableSlots <= 0) {
    return {
      idleAgentCount: idleAgents.length,
      availableSlots: 0,
      claimed: 0,
      failed: 0,
      errorsByKind: { claim: 0, workdir: 0, other: 0 },
    };
  }

  const toClaim = Math.min(idleAgents.length, availableSlots);
  let claimed = 0;
  let failed = 0;
  const errorsByKind = { claim: 0, workdir: 0, other: 0 };

  for (let i = 0; i < toClaim; i++) {
    const agent = idleAgents[i];
    if (!agent) continue;
    let succeeded = false;

    for (const habitatId of deps.habitatIds) {
      let claim: ClaimResult | null;
      try {
        claim = await deps.claim.claimNext(agent.id, habitatId, "");
      } catch {
        errorsByKind.claim++;
        continue;
      }
      if (!claim) continue;

      try {
        await deps.sessionManager.startSession(
          claim,
          agent.id,
          agent.apiKey,
          agent.type as CliType,
          agent.binPath ?? "",
          claim.daemonSessionId,
        );
        succeeded = true;
        claimed++;
        break;
      } catch (err) {
        if (err instanceof WorkdirError) {
          errorsByKind.workdir++;
          continue;
        }
        errorsByKind.other++;
      }
    }
    if (!succeeded) failed++;
  }

  return {
    idleAgentCount: idleAgents.length,
    availableSlots,
    claimed,
    failed,
    errorsByKind,
  };
}
