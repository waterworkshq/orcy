import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { deliverSlack } from "../../packages/api/src/services/notification-channels/slack.js";

const channelSlackPlugin: PluginModule = {
  manifest: {
    id: "channel-slack",
    version: "1.0.0",
    description: "Slack notification channel (migrated from in-tree)",
    contributions: [
      {
        kind: "notificationChannel",
        scope: "system",
        channelId: "slack",
        label: "Slack",
        requires: ["chatIntegrationReader"],
      },
    ],
  },
  channels: {
    slack: async (_ctx, payload) => {
      return deliverSlack(payload.delivery, payload.event);
    },
  },
};

export default channelSlackPlugin;
