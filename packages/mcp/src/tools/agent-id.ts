export function getCurrentAgentId(): string {
  return process.env.ORCY_AGENT_ID ?? '';
}
