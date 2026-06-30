import React from "react";
import { Tooltip } from "../ui/Tooltip.js";
import { useAgents } from "../../lib/useHabitatData.js";

interface AgentAvatarProps {
  agentId: string;
  /** What to render when the agent is not found. Defaults to null. */
  fallback?: React.ReactNode;
}

/**
 * Renders a circular avatar with the agent's 2-char initials, colored by agent type
 * (claude-code = blue, codex = purple, others = green). Wrapped in a Tooltip with
 * the agent's full name. Extracted from the duplicated implementations in TaskCard
 * and TaskTableColumns.
 */
export function AgentAvatar({ agentId, fallback = null }: AgentAvatarProps) {
  const { data: agents = [] } = useAgents();
  const agent = agents.find((a) => a.id === agentId) ?? null;
  if (!agent) return <>{fallback}</>;

  const initials = agent.name.slice(0, 2).toUpperCase();
  const color =
    agent.type === "claude-code"
      ? "bg-[var(--agent-blue)]"
      : agent.type === "codex"
        ? "bg-[var(--agent-purple)]"
        : "bg-[var(--agent-green)]";

  return (
    <Tooltip content={agent.name} position="top">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-[var(--on-surface)] ${color}`}
      >
        {initials}
      </div>
    </Tooltip>
  );
}
