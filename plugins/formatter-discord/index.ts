import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { formatDiscordPayload } from "../../packages/api/src/services/webhook-formatters/discord.js";

const formatterDiscordPlugin: PluginModule = {
  manifest: {
    id: "formatter-discord",
    version: "1.0.0",
    description: "Discord embed webhook payload formatter (migrated from in-tree)",
    contributions: [
      {
        kind: "webhookFormatter",
        scope: "system",
        formatId: "discord",
        label: "Discord Embed",
        requires: [],
      },
    ],
  },
  formatters: {
    discord: (enrichment, eventType) => formatDiscordPayload(enrichment as any, eventType),
  },
};

export default formatterDiscordPlugin;
