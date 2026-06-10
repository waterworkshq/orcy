import { describe, it, expect } from "vitest";
import * as domains from "./index.js";
import { api } from "../index.js";

describe("UI per-domain API organization", () => {
  const expectedNamespaces = [
    "habitatsApi",
    "missionsApi",
    "tasksApi",
    "subtasksApi",
    "columnsApi",
    "agentsApi",
    "authApi",
    "commentsApi",
    "missionCommentsApi",
    "templatesApi",
    "dashboardApi",
    "attachmentsApi",
    "presenceApi",
    "notificationsApi",
    "chatIntegrationsApi",
    "savedFiltersApi",
    "organizationsApi",
    "teamsApi",
    "qualityGatesApi",
    "timeTrackingApi",
    "effortApi",
    "dependenciesApi",
    "pulseApi",
    "auditApi",
    "scheduledTasksApi",
    "healthApi",
    "insightsApi",
    "reviewRulesApi",
    "reviewersApi",
    "sprintsApi",
    "integrationsApi",
    "daemonsApi",
    "skillApi",
    "codeEvidenceApi",
  ];

  it.each(expectedNamespaces)("exports %s", (name) => {
    expect((domains as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(expectedNamespaces)("%s is the same reference as api.<ns>", (name) => {
    const ns = name.replace(/Api$/, "");
    expect((domains as Record<string, unknown>)[name]).toBe((api as Record<string, unknown>)[ns]);
  });
});
