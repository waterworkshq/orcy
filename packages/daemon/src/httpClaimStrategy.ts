import type { IClaimStrategy, ClaimResult } from "@orcy/shared/types";
import type { DaemonApiClient } from "./api-client.js";

/** {@link IClaimStrategy} implementation that delegates to the daemon HTTP API via `DaemonApiClient`. Used by the standalone daemon's `PollLoop`. */
export class HttpClaimStrategy implements IClaimStrategy {
  constructor(private apiClient: DaemonApiClient) {}

  async claimNext(
    agentId: string,
    habitatId: string,
    _daemonId: string,
  ): Promise<ClaimResult | null> {
    return this.apiClient.claimNext(agentId, habitatId);
  }
}
