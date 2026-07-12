import { request } from "../transport.js";
import type {
  NotificationDelivery,
  NotificationEvent,
  NotificationRetentionPolicy,
  NotificationSubscription,
} from "../../types/index.js";

export interface InboxResponse {
  deliveries: NotificationDelivery[];
  total: number;
}

export interface SubscriptionsResponse {
  overrides: NotificationSubscription[];
  defaults: NotificationSubscription[];
}

export interface AdminSubscriptionsResponse {
  subscriptions: NotificationSubscription[];
}

export interface DeleteResponse {
  deleted: boolean;
}

export interface GetDeliveryResponse {
  delivery: NotificationDelivery;
  event: NotificationEvent;
}

export const notificationsV2Api = {
  inbox: (habitatId: string, options?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<InboxResponse>(
      `/habitats/${habitatId}/notifications/inbox${qs ? `?${qs}` : ""}`,
    );
  },
  history: (habitatId: string, options?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<InboxResponse>(
      `/habitats/${habitatId}/notifications/history${qs ? `?${qs}` : ""}`,
    );
  },
  getDelivery: (habitatId: string, deliveryId: string) =>
    request<GetDeliveryResponse>(
      `/habitats/${habitatId}/notifications/deliveries/${deliveryId}`,
    ),
  ack: (habitatId: string, deliveryId: string) =>
    request<NotificationDelivery>(
      `/habitats/${habitatId}/notifications/deliveries/${deliveryId}/ack`,
      { method: "POST" },
    ),
  snooze: (habitatId: string, deliveryId: string, snoozedUntil: string) =>
    request<NotificationDelivery>(
      `/habitats/${habitatId}/notifications/deliveries/${deliveryId}/snooze`,
      { method: "POST", body: JSON.stringify({ snoozedUntil }) },
    ),
  clear: (habitatId: string, deliveryId: string) =>
    request<NotificationDelivery>(
      `/habitats/${habitatId}/notifications/deliveries/${deliveryId}/clear`,
      { method: "POST" },
    ),
  subscriptions: (habitatId: string) =>
    request<SubscriptionsResponse>(
      `/habitats/${habitatId}/notifications/subscriptions`,
    ),
  adminSubscriptions: (habitatId: string) =>
    request<AdminSubscriptionsResponse>(
      `/habitats/${habitatId}/notifications/admin/subscriptions`,
    ),
  createSubscription: (habitatId: string, body: unknown) =>
    request<NotificationSubscription>(
      `/habitats/${habitatId}/notifications/admin/subscriptions`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  updateSubscription: (habitatId: string, subscriptionId: string, body: unknown) =>
    request<NotificationSubscription>(
      `/habitats/${habitatId}/notifications/admin/subscriptions/${subscriptionId}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  deleteSubscription: (habitatId: string, subscriptionId: string) =>
    request<DeleteResponse>(
      `/habitats/${habitatId}/notifications/admin/subscriptions/${subscriptionId}`,
      { method: "DELETE" },
    ),
  retention: (habitatId: string) =>
    request<NotificationRetentionPolicy | null>(
      `/habitats/${habitatId}/notifications/admin/retention`,
    ),
  updateRetention: (habitatId: string, body: unknown) =>
    request<NotificationRetentionPolicy>(
      `/habitats/${habitatId}/notifications/admin/retention`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  adminClear: (habitatId: string, deliveryIds: string[]) =>
    request<{ habitatId: string; cleared: number; errors: string[] }>(
      `/habitats/${habitatId}/notifications/admin/clear`,
      { method: "POST", body: JSON.stringify({ deliveryIds }) },
    ),
  migrateLegacy: (habitatId: string) =>
    request<{ created: number; updated: number; skipped: number; errors: string[] }>(
      `/habitats/${habitatId}/notifications/admin/migrate-legacy`,
      { method: "POST" },
    ),
};
