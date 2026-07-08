import { describe, it, expect } from "vitest";
import * as domains from "./index.js";
import { api } from "../index.js";

const expectedDomains = [
  ["agents", "agentsApi"],
  ["attachments", "attachmentsApi"],
  ["audit", "auditApi"],
  ["auth", "authApi"],
  ["automation", "automationApi"],
  ["chatIntegrations", "chatIntegrationsApi"],
  ["codeEvidence", "codeEvidenceApi"],
  ["columns", "columnsApi"],
  ["comments", "commentsApi"],
  ["daemons", "daemonsApi"],
  ["dashboard", "dashboardApi"],
  ["dependencies", "dependenciesApi"],
  ["effort", "effortApi"],
  ["habitats", "habitatsApi"],
  ["health", "healthApi"],
  ["insights", "insightsApi"],
  ["integrations", "integrationsApi"],
  ["metrics", "metricsApi"],
  ["missionComments", "missionCommentsApi"],
  ["missions", "missionsApi"],
  ["notifications", "notificationsApi"],
  ["notificationsV2", "notificationsV2Api"],
  ["organizations", "organizationsApi"],
  ["plugins", "pluginsApi"],
  ["presence", "presenceApi"],
  ["pulse", "pulseApi"],
  ["qualityGates", "qualityGatesApi"],
  ["remoteAccess", "remoteAccessApi"],
  ["reviewers", "reviewersApi"],
  ["reviewRules", "reviewRulesApi"],
  ["savedFilters", "savedFiltersApi"],
  ["scheduledTasks", "scheduledTasksApi"],
  ["skill", "skillApi"],
  ["sprints", "sprintsApi"],
  ["subtasks", "subtasksApi"],
  ["tasks", "tasksApi"],
  ["teams", "teamsApi"],
  ["templates", "templatesApi"],
  ["timeTracking", "timeTrackingApi"],
  ["triage", "triageApi"],
  ["wiki", "wikiApi"],
  ["workflows", "workflowsApi"],
] as const;

describe("UI per-domain API organization", () => {
  it.each(expectedDomains)("exports %s", (_ns, exportName) => {
    expect((domains as Record<string, unknown>)[exportName]).toBeDefined();
  });

  it.each(expectedDomains)(
    "%s export has the same method keys as the composed api namespace",
    (ns, exportName) => {
      const domainObj = (domains as Record<string, unknown>)[exportName] as object;
      const apiNs = (api as Record<string, unknown>)[ns] as object;
      expect(Object.keys(domainObj).sort()).toEqual(Object.keys(apiNs).sort());
    },
  );

  it("api.myTeams is teamsApi.myTeams", () => {
    expect(api.myTeams).toBe(domains.teamsApi.myTeams);
  });
});
