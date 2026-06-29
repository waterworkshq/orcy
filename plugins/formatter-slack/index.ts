import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { formatSlackPayload } from "../../packages/api/src/services/webhook-formatters/slack.js";

const formatterSlackPlugin: PluginModule = {
  manifest: {
    id: "formatter-slack",
    version: "1.0.0",
    description: "Slack Block Kit webhook payload formatter (migrated from in-tree)",
    contributions: [
      {
        kind: "webhookFormatter",
        scope: "system",
        formatId: "slack",
        label: "Slack Block Kit",
        requires: [],
      },
    ],
  },
  formatters: {
    slack: (enrichment, eventType) => formatSlackPayload(enrichment as any, eventType),
  },
};

export default formatterSlackPlugin;
