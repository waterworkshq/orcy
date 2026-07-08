import { request } from "../transport.js";

export const authApi = {
  login: (data: { username: string; password: string }) =>
    request<{ token: string; user: { id: string; username: string; role: string } }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify(data) },
    ),
  setupStatus: () => request<{ needsSetup: boolean }>("/auth/setup-status"),
  register: (data: { username: string; password: string; displayName?: string }) =>
    request<{
      token: string;
      user: { id: string; username: string; role: string; displayName?: string };
    }>("/auth/register", { method: "POST", body: JSON.stringify(data) }),
  me: () =>
    request<{ user: { id: string; username: string; role: string; displayName?: string } }>(
      "/auth/me",
    ),
  logout: () => request<{ success: boolean }>("/auth/logout", { method: "POST" }),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    request<{ success: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateProfile: (data: { displayName?: string }) =>
    request<{ user: { id: string; username: string; role: string; displayName?: string } }>(
      "/auth/me",
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    ),
};
