import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { deliverDiscord } from "../../packages/api/src/services/notification-channels/discord.js";

const channelDiscordPlugin: PluginModule = {
  manifest: {
    id: "channel-discord",
    version: "1.0.0",
    description: "Discord notification channel (migrated from in-tree)",
    contributions: [
      {
        kind: "notificationChannel",
        scope: "system",
        channelId: "discord",
        label: "Discord",
        requires: ["chatIntegrationReader"],
      },
    ],
  },
  channels: {
    discord: async (_ctx, payload) => {
      return deliverDiscord(payload.delivery, payload.event);
    },
  },
};

export default channelDiscordPlugin;
