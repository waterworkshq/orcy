import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { useAgentsListWithTasks } from "../../lib/useHabitatData.js";
import type { HabitatAgentMail } from "../../api/domains/agentMail.js";

interface HabitatAgentMailInboxProps {
  habitatId: string;
}

function agentLabel(
  agentId: string,
  names: Map<string, string>,
): string {
  return names.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`;
}

function MailRow({
  message,
  names,
}: {
  message: HabitatAgentMail;
  names: Map<string, string>;
}) {
  const unread = message.readAt == null;
  return (
    <article className="rounded-md border border-border p-2">
      <h4 className="truncate text-xs font-medium">{message.subject}</h4>
      <p className="mt-0.5 text-[10px] text-muted-foreground">
        {agentLabel(message.fromAgentId, names)} → {agentLabel(message.toAgentId, names)}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-foreground">{message.body}</p>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {unread ? "Recipient unread" : `Recipient read ${message.readAt}`}
      </p>
    </article>
  );
}

/** Read-only habitat projection of agent↔agent mail. Does not mark mail read. */
export function HabitatAgentMailInbox({ habitatId }: HabitatAgentMailInboxProps) {
  const agentsQuery = useAgentsListWithTasks(habitatId);
  const mailQuery = useQuery({
    queryKey: queryKeys.agentMail.list(habitatId),
    queryFn: () => api.agentMail.listByHabitat(habitatId, { limit: 20 }),
  });

  const names = new Map<string, string>();
  for (const item of agentsQuery.data ?? []) {
    names.set(item.agent.id, item.agent.name);
  }

  return (
    <section className="mb-5" aria-labelledby="habitat-agent-mail-heading">
      <div className="mb-2 flex items-center gap-1.5">
        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 id="habitat-agent-mail-heading" className="text-xs font-semibold">
          Agent mail
        </h3>
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Point-to-point between agents. Local members can read bodies. Reply on Pulse, not here.
      </p>
      {mailQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading agent mail…</p>
      ) : mailQuery.error ? (
        <p className="text-xs text-destructive">
          Failed to load agent mail: {(mailQuery.error as Error).message}
        </p>
      ) : (mailQuery.data?.messages.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">No agent mail in this habitat.</p>
      ) : (
        <div className="space-y-2">
          {mailQuery.data!.messages.map((message) => (
            <MailRow key={message.id} message={message} names={names} />
          ))}
        </div>
      )}
    </section>
  );
}
