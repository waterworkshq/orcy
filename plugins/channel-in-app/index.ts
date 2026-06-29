import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { deliverInApp } from "../../packages/api/src/services/notification-channels/inApp.js";

const channelInAppPlugin: PluginModule = {
  manifest: {
    id: "channel-in-app",
    version: "1.0.0",
    description: "In-app notification channel (migrated from in-tree)",
    contributions: [
      {
        kind: "notificationChannel",
        scope: "system",
        channelId: "in_app",
        label: "In-App",
        requires: [],
      },
    ],
  },
  channels: {
    in_app: async (_ctx, payload) => {
      return deliverInApp(payload.delivery, payload.event);
    },
  },
};

export default channelInAppPlugin;
