import { request } from "../transport.js";

export const remoteAccessApi = {
  // Readiness
  getReadiness: (habitatId: string, manualInviteSelected?: boolean) =>
    request<{
      profile: string;
      ready: boolean;
      canInvite: boolean;
      checks: unknown[];
      baseUrl: string | null;
      hasProvider: boolean;
      hasManualInviteOption: boolean;
    }>(
      `/habitats/${habitatId}/remote-access/readiness${manualInviteSelected ? "?manualInviteSelected=true" : ""}`,
    ),

  // Providers
  listProviders: (habitatId: string) =>
    request<{ providers: unknown[] }>(`/habitats/${habitatId}/remote-access/providers`),
  createProvider: (habitatId: string, body: Record<string, unknown>) =>
    request<{ provider: unknown }>(`/habitats/${habitatId}/remote-access/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProvider: (habitatId: string, providerId: string, body: Record<string, unknown>) =>
    request<{ provider: unknown }>(`/habitats/${habitatId}/remote-access/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProvider: (habitatId: string, providerId: string) =>
    request(`/habitats/${habitatId}/remote-access/providers/${providerId}`, { method: "DELETE" }),

  // Invites
  listInvites: (habitatId: string) =>
    request<{ invites: unknown[] }>(`/habitats/${habitatId}/remote-access/invites`),
  createInvite: (habitatId: string, body: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/invites`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeInvite: (habitatId: string, inviteId: string, body?: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/invites/${inviteId}/revoke`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Pods
  listPods: (habitatId: string, status?: string) =>
    request<{ pods: unknown[] }>(
      `/habitats/${habitatId}/remote-access/remote-pods${status ? `?status=${status}` : ""}`,
    ),
  getPod: (habitatId: string, podId: string) =>
    request<{ pod: unknown }>(`/habitats/${habitatId}/remote-access/remote-pods/${podId}`),
  updatePod: (habitatId: string, podId: string, body: Record<string, unknown>) =>
    request<{ pod: unknown }>(`/habitats/${habitatId}/remote-access/remote-pods/${podId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  listPodParticipants: (habitatId: string, podId: string) =>
    request<{ participants: unknown[] }>(
      `/habitats/${habitatId}/remote-access/remote-pods/${podId}/participants`,
    ),

  // Participants
  getParticipant: (habitatId: string, participantId: string) =>
    request<{ participant: unknown }>(
      `/habitats/${habitatId}/remote-access/participants/${participantId}`,
    ),
  updateParticipant: (habitatId: string, participantId: string, body: Record<string, unknown>) =>
    request<{ participant: unknown }>(
      `/habitats/${habitatId}/remote-access/participants/${participantId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  // Grants
  listGrants: (habitatId: string) =>
    request<{ grants: unknown[] }>(`/habitats/${habitatId}/remote-access/grants`),
  getGrant: (habitatId: string, grantId: string) =>
    request<{ grant: unknown }>(`/habitats/${habitatId}/remote-access/grants/${grantId}`),
  createGrant: (habitatId: string, body: Record<string, unknown>) =>
    request<{ grant: unknown }>(`/habitats/${habitatId}/remote-access/grants`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeGrant: (habitatId: string, grantId: string, body: Record<string, unknown>) =>
    request<{ grant: unknown }>(`/habitats/${habitatId}/remote-access/grants/${grantId}/revoke`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  previewGrant: (habitatId: string, body: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/grants/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Credentials
  createCredential: (habitatId: string, participantId: string, body: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/participants/${participantId}/credentials`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getCredential: (habitatId: string, credentialId: string) =>
    request(`/habitats/${habitatId}/remote-access/credentials/${credentialId}`),
  rotateCredential: (habitatId: string, credentialId: string, body?: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/credentials/${credentialId}/rotate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeCredential: (habitatId: string, credentialId: string, body?: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/credentials/${credentialId}/revoke`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listParticipantCredentials: (habitatId: string, participantId: string) =>
    request<{ credentials: unknown[] }>(
      `/habitats/${habitatId}/remote-access/participants/${participantId}/credentials`,
    ),
  regenerateMcpConfig: (habitatId: string, credentialId: string, body?: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/credentials/${credentialId}/mcp-config`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Management view
  getManagement: (habitatId: string) =>
    request<unknown>(`/habitats/${habitatId}/remote-access/management`),

  // Webhook endpoints
  listWebhookEndpoints: (habitatId: string) =>
    request<{ endpoints: unknown[] }>(`/habitats/${habitatId}/remote-access/webhook-endpoints`),
  createWebhookEndpoint: (habitatId: string, body: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/webhook-endpoints`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  approveWebhookEndpoint: (habitatId: string, endpointId: string) =>
    request(`/habitats/${habitatId}/remote-access/webhook-endpoints/${endpointId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  enableWebhookEndpoint: (habitatId: string, endpointId: string) =>
    request(`/habitats/${habitatId}/remote-access/webhook-endpoints/${endpointId}/enable`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  disableWebhookEndpoint: (habitatId: string, endpointId: string, body: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/webhook-endpoints/${endpointId}/disable`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rejectWebhookEndpoint: (habitatId: string, endpointId: string, body: Record<string, unknown>) =>
    request(`/habitats/${habitatId}/remote-access/webhook-endpoints/${endpointId}/reject`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteWebhookEndpoint: (habitatId: string, endpointId: string) =>
    request(`/habitats/${habitatId}/remote-access/webhook-endpoints/${endpointId}`, {
      method: "DELETE",
    }),
};
