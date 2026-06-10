import type { QueryClient } from "@tanstack/react-query";
import type { SSEEvent, Notification } from "../types/index.js";
import type { AgentSlice } from "../store/slices/agentSlice.js";
import type { HabitatSlice } from "../store/slices/habitatSlice.js";
import type { MissionSlice } from "../store/slices/missionSlice.js";
import type { PresenceSlice } from "../store/slices/presenceSlice.js";
import type { TaskSlice } from "../store/slices/taskSlice.js";
import type { ThemeSlice } from "../store/slices/themeSlice.js";
import type { UiSlice } from "../store/slices/uiSlice.js";

export type SSEEventType = SSEEvent["type"];
export type SSEEventOf<T extends SSEEventType> = Extract<SSEEvent, { type: T }>;

export type SSEStoreState = ThemeSlice &
  HabitatSlice &
  MissionSlice &
  TaskSlice &
  AgentSlice &
  PresenceSlice &
  UiSlice & {
    recentSSEEvents: SSEEvent[];
  };

export type SSEStoreSet = (partial: Partial<SSEStoreState>) => void;

export interface SSEStoreContext<T extends SSEEventType = SSEEventType> {
  event: SSEEventOf<T>;
  state: SSEStoreState;
  set: SSEStoreSet;
}

export interface SSECacheContext<T extends SSEEventType = SSEEventType> {
  event: SSEEventOf<T>;
  boardId: string;
  queryClient: QueryClient;
  getState: () => SSEStoreState;
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
  zustand?: (context: SSEStoreContext) => void;
  cache?: (context: SSECacheContext) => void;
  notification?: (context: SSENotificationContext) => SSENotificationResult | null;
}

export interface SSEEventHandlerFor<T extends SSEEventType> {
  zustand?: (context: SSEStoreContext<T>) => void;
  cache?: (context: SSECacheContext) => void;
  notification?: (context: SSENotificationContext<T>) => SSENotificationResult | null;
}

export function defineSSEHandler<T extends SSEEventType>(
  handler: SSEEventHandlerFor<T>,
): SSEEventHandler {
  return handler as unknown as SSEEventHandler;
}
