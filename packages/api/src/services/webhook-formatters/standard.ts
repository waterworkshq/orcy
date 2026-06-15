/** Extra context fetched for a webhook event before building the standard payload. */
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

/** Builds the standard JSON payload for a webhook delivery using the provided {@link EventEnrichment}. */
export function formatStandardPayload(
  enrichment: EventEnrichment,
  eventType: string,
  deliveryId: string,
): object {
  return {
    id: deliveryId,
    timestamp: new Date().toISOString(),
    habitatId: enrichment.habitatName,
    event: eventType,
    data: enrichment,
  };
}
