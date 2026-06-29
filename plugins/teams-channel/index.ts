import type { PluginModule } from "../../packages/api/src/plugins/types.js";

/**
 * teams-channel reference plugin (ADR-0017).
 *
 * Declares a `notificationChannel` contribution for `channelId: "teams"`. When
 * a notification delivery is dispatched for channel "teams", `pluginManager`
 * resolves this handler from `channelRegistry` and invokes it with the parsed
 * `NotificationPayload`. The handler reads the webhook URL from
 * `ORCY_TEAMS_WEBHOOK_URL` at invocation time (env may be set after plugin
 * load) and posts an Adaptive Card via the Office 365 connector webhook.
 *
 * Surface-only ship: no in-tree channels are migrated in v0.22.0 (ADR-0017).
 */
const teamsChannelPlugin: PluginModule = {
  manifest: {
    id: "teams-channel",
    version: "1.0.0",
    description: "Microsoft Teams notification channel (reference plugin)",
    contributions: [
      {
        kind: "notificationChannel",
        scope: "system",
        channelId: "teams",
        label: "Microsoft Teams",
        requires: [],
      },
    ],
  },
  channels: {
    teams: async (_ctx, payload) => {
      const webhookUrl = process.env.ORCY_TEAMS_WEBHOOK_URL;
      if (!webhookUrl) {
        return {
          success: false,
          error: "ORCY_TEAMS_WEBHOOK_URL not configured",
        };
      }
      try {
        const card = {
          "@type": "MessageCard",
          "@context": "http://schema.org/extensions",
          themeColor: "0072C6",
          title: payload.event.title || "Orcy Notification",
          text: payload.event.body || payload.event.title || "",
          sections: [
            {
              facts: [
                { name: "Event", value: payload.event.eventType },
                { name: "Severity", value: payload.event.severity ?? "normal" },
              ],
            },
          ],
        };
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
        });
        if (!response.ok) {
          return {
            success: false,
            error: `Teams webhook returned ${response.status}`,
            statusCode: response.status,
          };
        }
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: "Teams webhook request failed",
        };
      }
    },
  },
};

export default teamsChannelPlugin;
