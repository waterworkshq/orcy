import type { QueryClient } from "@tanstack/react-query";
import type { SSEEvent, Notification } from "../types/index.js";
import type { HabitatSlice } from "../store/slices/habitatSlice.js";
import type { PresenceSlice } from "../store/slices/presenceSlice.js";
import type { ThemeSlice } from "../store/slices/themeSlice.js";
import type { UiSlice } from "../store/slices/uiSlice.js";

export type SSEEventType = SSEEvent["type"];
export type SSEEventOf<T extends SSEEventType> = Extract<SSEEvent, { type: T }>;

export type SSEStoreState = ThemeSlice &
  HabitatSlice &
  PresenceSlice &
  UiSlice & {
    recentSSEEvents: SSEEvent[];
  };

export type SSEStoreSet = (partial: Partial<SSEStoreState>) => void;

/**
 * Ephemeral projection context. Type-constrained to non-domain Zustand state
 * (presence, WIP alerts, theme, UI selection). Server-domain entities
 * (Habitat/Column/Mission/Task/Agent) are NEVER written here — the server
 * projector owns those through React Query.
 */
export interface EphemeralProjectionContext<T extends SSEEventType = SSEEventType> {
  event: SSEEventOf<T>;
  state: SSEStoreState;
  set: SSEStoreSet;
}

/**
 * Server projection context. The server projector is the only SSE code allowed
 * to patch or invalidate durable server data. It carries BOTH the subscription
 * Habitat (the generation's stream target) and the current route Habitat, plus
 * `isActive` so an async cancel-before-patch can recheck its generation after
 * every await, and `navigateHome` for the route-safe `habitat.deleted` effect.
 */
export interface ServerProjectionContext<T extends SSEEventType = SSEEventType> {
  event: SSEEventOf<T>;
  queryClient: QueryClient;
  subscriptionHabitatId: string;
  routeHabitatId: string;
  isActive: () => boolean;
  navigateHome: () => void;
}

export interface SSENotificationContext<T extends SSEEventType = SSEEventType> {
  event: SSEEventOf<T>;
  state: SSEStoreState;
  currentUserId: string | null;
}

export interface SSEToastNotification {
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export interface SSENotificationResult {
  app?: Omit<Notification, "id" | "read">;
  toast?: SSEToastNotification;
}

export interface SSEEventHandler {
  server?: (context: ServerProjectionContext) => void | Promise<void>;
  ephemeral?: (context: EphemeralProjectionContext) => void;
  notification?: (context: SSENotificationContext) => SSENotificationResult | null;
}

export interface SSEEventHandlerFor<T extends SSEEventType> {
  server?: (context: ServerProjectionContext<T>) => void | Promise<void>;
  ephemeral?: (context: EphemeralProjectionContext<T>) => void;
  notification?: (context: SSENotificationContext<T>) => SSENotificationResult | null;
}

export function defineSSEHandler<T extends SSEEventType>(
  handler: SSEEventHandlerFor<T>,
): SSEEventHandler {
  return handler as unknown as SSEEventHandler;
}