import { getOrcyConfig } from '@orcy/shared';

export function getCurrentAgentId(): string {
  return getOrcyConfig().agentId;
}
