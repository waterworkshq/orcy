import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { deliverWebhook } from "../../packages/api/src/services/notification-channels/webhook.js";

const channelWebhookPlugin: PluginModule = {
  manifest: {
    id: "channel-webhook",
    version: "1.0.0",
    description: "Webhook notification channel (migrated from in-tree)",
    contributions: [
      {
        kind: "notificationChannel",
        scope: "system",
        channelId: "webhook",
        label: "Webhook",
        requires: [],
      },
    ],
  },
  channels: {
    webhook: async (_ctx, payload) => {
      const webhookUrl = payload.event.payload?.webhookUrl as string | undefined;
      if (!webhookUrl) {
        return { success: false, error: "No webhook URL configured" };
      }
      return deliverWebhook(payload.delivery, payload.event, webhookUrl);
    },
  },
};

export default channelWebhookPlugin;
