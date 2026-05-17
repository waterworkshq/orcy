export interface EventEnrichment {
  habitatName: string;
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
    habitatId: enrichment.habitatName,
    event: eventType,
    data: enrichment,
  };
}
