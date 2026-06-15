import type { IClaimStrategy, ClaimResult } from "@orcy/shared/types";
import type { DaemonApiClient } from "./api-client.js";

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
