import { request } from "../transport.js";
import type { Team, TeamMember } from "../../types/index.js";

export const teamsApi = {
  get: (id: string) => request<{ team: Team }>(`/teams/${id}`).then((r) => r.team),
  delete: (id: string) => request<void>(`/teams/${id}`, { method: "DELETE" }),
  listMembers: (id: string) =>
    request<{ members: TeamMember[] }>(`/teams/${id}/members`).then((r) => r.members),
  addMember: (
    id: string,
    data: { userId: string; role?: import("../../types/index.js").TeamMemberRole },
  ) =>
    request<{ member: TeamMember }>(`/teams/${id}/members`, {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => r.member),
  removeMember: (id: string, userId: string) =>
    request<void>(`/teams/${id}/members/${userId}`, { method: "DELETE" }),
  updateMemberRole: (
    id: string,
    userId: string,
    role: import("../../types/index.js").TeamMemberRole,
  ) =>
    request<{ member: TeamMember }>(`/teams/${id}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }).then((r) => r.member),
  myTeams: () => request<{ teams: Team[] }>("/users/me/teams").then((r) => r.teams),
};
