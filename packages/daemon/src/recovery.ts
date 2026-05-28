import type { DaemonApiClient } from "./api-client.js";
import type { RegisteredAgent } from "./types.js";

export interface RecoveredSession {
  sessionId: string;
  action: "released" | "failed";
  reason: string;
}

export async function recoverSessions(
  apiClient: DaemonApiClient,
  agents: RegisteredAgent[],
): Promise<RecoveredSession[]> {
  const results: RecoveredSession[] = [];

  let activeSessions: any[];
  try {
    activeSessions = await apiClient.getActiveSessions();
  } catch {
    return results;
  }

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  for (const session of activeSessions) {
    const agent = agentMap.get(session.agentId);

    if (!agent) {
      results.push({
        sessionId: session.id,
        action: "released",
        reason: "Agent no longer managed by this daemon",
      });
      try {
        await apiClient.updateSession(session.id, {
          status: "released",
          lastProgress: "Recovered: agent no longer available",
        });
      } catch {}
      continue;
    }

    if (session.workdir === "pending") {
      results.push({
        sessionId: session.id,
        action: "released",
        reason: "Session was in pending workdir state at crash",
      });
      try {
        await apiClient.updateSession(session.id, {
          status: "released",
          lastProgress: "Recovered: session never fully started",
        });
      } catch {}
      continue;
    }

    results.push({
      sessionId: session.id,
      action: "failed",
      reason: "Daemon restarted while session was active",
    });
    try {
      await apiClient.updateSession(session.id, {
        status: "failed",
        lastProgress: "Recovered: daemon restarted mid-session",
      });
    } catch {}
  }

  return results;
}
