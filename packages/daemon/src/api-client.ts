import type { DaemonConfig, RegisteredDaemon, ClaimResult, DetectedCli } from "./types.js";

export class DaemonApiClient {
  private baseUrl: string;
  private daemonToken: string | null = null;
  private registrationToken: string | null;

  constructor(config: DaemonConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.registrationToken = config.registrationToken;
  }

  setDaemonToken(token: string): void {
    this.daemonToken = token;
  }

  async register(
    name: string,
    hostname: string,
    daemonVersion: string,
    detectedClis: DetectedCli[],
    habitatIds: string[],
  ): Promise<RegisteredDaemon> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.registrationToken) {
      headers["X-Registration-Token"] = this.registrationToken;
    }

    const res = await fetch(`${this.baseUrl}/api/v1/daemon/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        hostname,
        maxConcurrent: 4,
        daemonVersion,
        detectedClis: detectedClis.map((c) => ({
          type: c.type,
          version: c.version ?? undefined,
          path: c.path,
        })),
        habitatIds,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registration failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as RegisteredDaemon;
    this.daemonToken = data.daemonToken;
    return data;
  }

  async heartbeat(
    agentStatuses?: Array<{ agentId: string; status: string }>,
    sessionProgresses?: Array<{ sessionId: string; lastProgress?: string }>,
  ): Promise<{ nextCheckInSeconds: number }> {
    this.requireToken();
    const res = await fetch(`${this.baseUrl}/api/v1/daemon/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Daemon-Token": this.daemonToken!,
      },
      body: JSON.stringify({ agentStatuses, sessionProgresses }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Heartbeat failed (${res.status}): ${body}`);
    }

    return (await res.json()) as { nextCheckInSeconds: number };
  }

  async claimNext(agentId: string, habitatId: string): Promise<ClaimResult | null> {
    this.requireToken();
    const res = await fetch(`${this.baseUrl}/api/v1/daemon/tasks/claim-next`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Daemon-Token": this.daemonToken!,
      },
      body: JSON.stringify({ daemonId: "", agentId, habitatId }),
    });

    if (res.status === 204) return null;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Claim-next failed (${res.status}): ${body}`);
    }

    return (await res.json()) as ClaimResult;
  }

  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    this.requireToken();
    const res = await fetch(`${this.baseUrl}/api/v1/daemon/sessions/${sessionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Daemon-Token": this.daemonToken!,
      },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Session update failed (${res.status}): ${body}`);
    }
  }

  async getActiveSessions(): Promise<
    Array<{
      id: string;
      agentId: string;
      taskId: string;
      habitatId: string;
      status: string;
      workdir: string;
      pid: number | null;
    }>
  > {
    this.requireToken();
    const res = await fetch(`${this.baseUrl}/api/v1/daemon/sessions`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Daemon-Token": this.daemonToken!,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Get sessions failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { sessions: any[] };
    return data.sessions;
  }

  private requireToken(): void {
    if (!this.daemonToken) {
      throw new Error("Daemon token not set — call register() first");
    }
  }
}
