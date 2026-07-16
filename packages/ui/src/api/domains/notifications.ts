import { request } from "../transport.js";
import type { NotificationPreferences } from "../../types/index.js";

export const notificationsApi = {
  getGlobalPrefs: () =>
    request<{ preferences: NotificationPreferences; email: string | null }>(
      "/users/me/notification-preferences",
    ),
  updateGlobalPrefs: (data: Partial<NotificationPreferences>) =>
    request<{ preferences: NotificationPreferences }>("/users/me/notification-preferences", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getHabitatPrefs: (habitatId: string) =>
    request<{ preferences: NotificationPreferences }>(
      `/habitats/${habitatId}/notification-preferences`,
    ),
  updateHabitatPrefs: (habitatId: string, data: Partial<NotificationPreferences>) =>
    request<{ preferences: NotificationPreferences }>(
      `/habitats/${habitatId}/notification-preferences`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    ),
  updateEmail: (email: string | null) =>
    request<{ success: boolean; email: string | null }>("/users/me/email", {
      method: "PUT",
      body: JSON.stringify({ email }),
    }),
};
