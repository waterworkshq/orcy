import { request } from "../transport.js";

export const notificationsV2Api = {
  inbox: (habitatId: string, options?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<{ deliveries: unknown[]; total: number }>(
      `/habitats/${habitatId}/notifications/inbox${qs ? `?${qs}` : ""}`,
    );
  },
  history: (habitatId: string, options?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<{ deliveries: unknown[]; total: number }>(
      `/habitats/${habitatId}/notifications/history${qs ? `?${qs}` : ""}`,
    );
  },
  getDelivery: (habitatId: string, deliveryId: string) =>
    request<{ delivery: unknown; event: unknown }>(
      `/habitats/${habitatId}/notifications/deliveries/${deliveryId}`,
    ),
  ack: (habitatId: string, deliveryId: string) =>
    request<unknown>(`/habitats/${habitatId}/notifications/deliveries/${deliveryId}/ack`, {
      method: "POST",
    }),
  snooze: (habitatId: string, deliveryId: string, snoozedUntil: string) =>
    request<unknown>(`/habitats/${habitatId}/notifications/deliveries/${deliveryId}/snooze`, {
      method: "POST",
      body: JSON.stringify({ snoozedUntil }),
    }),
  clear: (habitatId: string, deliveryId: string) =>
    request<unknown>(`/habitats/${habitatId}/notifications/deliveries/${deliveryId}/clear`, {
      method: "POST",
    }),
  subscriptions: (habitatId: string) =>
    request<unknown>(`/habitats/${habitatId}/notifications/subscriptions`),
  adminSubscriptions: (habitatId: string) =>
    request<{ subscriptions: unknown[] }>(
      `/habitats/${habitatId}/notifications/admin/subscriptions`,
    ),
  createSubscription: (habitatId: string, body: unknown) =>
    request<unknown>(`/habitats/${habitatId}/notifications/admin/subscriptions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSubscription: (habitatId: string, subscriptionId: string, body: unknown) =>
    request<unknown>(`/habitats/${habitatId}/notifications/admin/subscriptions/${subscriptionId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSubscription: (habitatId: string, subscriptionId: string) =>
    request<{ deleted: boolean }>(
      `/habitats/${habitatId}/notifications/admin/subscriptions/${subscriptionId}`,
      { method: "DELETE" },
    ),
  retention: (habitatId: string) =>
    request<unknown>(`/habitats/${habitatId}/notifications/admin/retention`),
  updateRetention: (habitatId: string, body: unknown) =>
    request<unknown>(`/habitats/${habitatId}/notifications/admin/retention`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adminClear: (habitatId: string, deliveryIds: string[]) =>
    request<unknown>(`/habitats/${habitatId}/notifications/admin/clear`, {
      method: "POST",
      body: JSON.stringify({ deliveryIds }),
    }),
  migrateLegacy: (habitatId: string) =>
    request<unknown>(`/habitats/${habitatId}/notifications/admin/migrate-legacy`, {
      method: "POST",
    }),
};
