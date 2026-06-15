import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { habitatSubscribe, habitatUnsubscribe } from "./subscription.js";

/** MCP `Tool` registration schema for habitat event subscriptions (subscribe, unsubscribe). */
export const SUBSCRIPTION_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_habitat_subscription",
  description:
    "Subscription operations: subscribe to real-time board events via MCP notifications, or unsubscribe to stop receiving events",
  actions: ["subscribe", "unsubscribe"],
  sharedParams: {
    boardId: {
      type: "string",
      description: "The UUID of the Orcy habitat to subscribe to or unsubscribe from",
    },
  },
});

/** Action-name → {@link Handler} map routing each subscription operation to its habitat client implementation. */
export const SUBSCRIPTION_ACTIONS: Record<string, Handler> = {
  subscribe: habitatSubscribe,
  unsubscribe: habitatUnsubscribe,
};

/** Top-level {@link ToolHandler} that routes incoming `orcy_habitat_subscription` MCP calls to the matching action. */
export const SUBSCRIPTION_DISPATCH_HANDLER = createDispatchHandler(SUBSCRIPTION_ACTIONS);
