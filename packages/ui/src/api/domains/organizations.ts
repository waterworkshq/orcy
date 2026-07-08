import { request } from "../transport.js";
import type { Organization, Team } from "../../types/index.js";

export const organizationsApi = {
  list: () =>
    request<{ organizations: Organization[] }>("/organizations").then((r) => r.organizations),
  get: (id: string) =>
    request<{ organization: Organization }>(`/organizations/${id}`).then((r) => r.organization),
  create: (data: { name: string; slug: string }) =>
    request<{ organization: Organization }>("/organizations", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => r.organization),
  listTeams: (orgId: string) =>
    request<{ teams: Team[] }>(`/organizations/${orgId}/teams`).then((r) => r.teams),
  createTeam: (orgId: string, data: { name: string; slug: string }) =>
    request<{ team: Team }>(`/organizations/${orgId}/teams`, {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => r.team),
};
