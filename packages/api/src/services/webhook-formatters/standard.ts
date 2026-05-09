export interface EventEnrichment {
  boardName: string;
  task?: {
    id: string;
    title: string;
    status: string;
    priority: string;
    assignedAgentId: string | null;
    assignedAgentName?: string;
    result?: string | null;
    artifacts: Array<{ type: string; url: string; description: string }>;
  };
  agent?: { id: string; name: string };
  columnName?: string;
}

export function formatStandardPayload(enrichment: EventEnrichment, eventType: string, deliveryId: string): object {
  return {
    id: deliveryId,
    timestamp: new Date().toISOString(),
    boardId: enrichment.boardName,
    event: eventType,
    data: enrichment,
  };
}
