import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  getInbox,
  getHistory,
  getDelivery,
  acknowledgeDelivery,
  snoozeDelivery,
  clearDelivery,
  getSubscriptions,
} from "./notifications.js";

/** MCP {@link Tool} descriptor for self-service notification operations: inbox, history, delivery, ack, snooze, clear, and subscriptions. */
export const NOTIFICATION_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_notification",
  description:
    "Notification operations (self-service only): get_inbox, get_history, get_delivery, ack, snooze, clear, get_subscriptions",
  actions: [
    "get_inbox",
    "get_history",
    "get_delivery",
    "ack",
    "snooze",
    "clear",
    "get_subscriptions",
  ],
  sharedParams: {
    boardId: { type: "string", description: "Habitat UUID" },
    deliveryId: { type: "string", description: "Notification delivery UUID" },
    snoozedUntil: { type: "string", description: "ISO timestamp to snooze until" },
    limit: { type: "number", description: "Max results (default 50)" },
    offset: { type: "number", description: "Pagination offset" },
  },
});

/** Dispatch map from MCP action name (e.g. `get_inbox`, `ack`) to the {@link Handler} that implements it. */
export const NOTIFICATION_ACTIONS: Record<string, Handler> = {
  get_inbox: getInbox,
  get_history: getHistory,
  get_delivery: getDelivery,
  ack: acknowledgeDelivery,
  snooze: snoozeDelivery,
  clear: clearDelivery,
  get_subscriptions: getSubscriptions,
};

/** Top-level handler that routes incoming `orcy_notification` MCP calls into {@link NOTIFICATION_ACTIONS}. */
export const NOTIFICATION_DISPATCH_HANDLER = createDispatchHandler(NOTIFICATION_ACTIONS);
