import { getOrcyConfig } from "@orcy/shared";

/** Returns the calling agent's identifier from the loaded orcy config. */
export function getCurrentAgentId(): string {
  return getOrcyConfig().agentId;
}
