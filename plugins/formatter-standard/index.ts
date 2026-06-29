import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { formatStandardPayload } from "../../packages/api/src/services/webhook-formatters/standard.js";

const formatterStandardPlugin: PluginModule = {
  manifest: {
    id: "formatter-standard",
    version: "1.0.0",
    description: "Standard JSON webhook payload formatter (migrated from in-tree)",
    contributions: [
      {
        kind: "webhookFormatter",
        scope: "system",
        formatId: "standard",
        label: "Standard JSON",
        requires: [],
      },
    ],
  },
  formatters: {
    standard: (enrichment, eventType, deliveryId) =>
      formatStandardPayload(enrichment as any, eventType, deliveryId),
  },
};

export default formatterStandardPlugin;
