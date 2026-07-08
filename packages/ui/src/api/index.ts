/**
 * API client — pure composition surface.
 *
 * Imports per-domain API modules and re-exports them as the `api` object.
 * Contains NO endpoint implementations — all logic lives in domain modules.
 */
import { agentsApi } from "./domains/agents.js";
import { attachmentsApi } from "./domains/attachments.js";
import { auditApi } from "./domains/audit.js";
import { authApi } from "./domains/auth.js";
import { automationApi } from "./domains/automation.js";
import { chatIntegrationsApi } from "./domains/chatIntegrations.js";
import { codeEvidenceApi } from "./domains/codeEvidence.js";
import { columnsApi } from "./domains/columns.js";
import { commentsApi } from "./domains/comments.js";
import { daemonsApi } from "./domains/daemons.js";
import { dashboardApi } from "./domains/dashboard.js";
import { dependenciesApi } from "./domains/dependencies.js";
import { effortApi } from "./domains/effort.js";
import { habitatsApi } from "./domains/habitats.js";
import { healthApi } from "./domains/health.js";
import { insightsApi } from "./domains/insights.js";
import { integrationsApi } from "./domains/integrations.js";
import { metricsApi } from "./domains/metrics.js";
import { missionCommentsApi } from "./domains/missionComments.js";
import { missionsApi } from "./domains/missions.js";
import { notificationsApi } from "./domains/notifications.js";
import { notificationsV2Api } from "./domains/notificationsV2.js";
import { organizationsApi } from "./domains/organizations.js";
import { pluginsApi } from "./domains/plugins.js";
import { presenceApi } from "./domains/presence.js";
import { pulseApi } from "./domains/pulse.js";
import { qualityGatesApi } from "./domains/qualityGates.js";
import { remoteAccessApi } from "./domains/remoteAccess.js";
import { reviewersApi } from "./domains/reviewers.js";
import { reviewRulesApi } from "./domains/reviewRules.js";
import { savedFiltersApi } from "./domains/savedFilters.js";
import { scheduledTasksApi } from "./domains/scheduledTasks.js";
import { skillApi } from "./domains/skill.js";
import { sprintsApi } from "./domains/sprints.js";
import { subtasksApi } from "./domains/subtasks.js";
import { tasksApi } from "./domains/tasks.js";
import { teamsApi } from "./domains/teams.js";
import { templatesApi } from "./domains/templates.js";
import { timeTrackingApi } from "./domains/timeTracking.js";
import { triageApi } from "./domains/triage.js";
import { wikiApi } from "./domains/wiki.js";
import { workflowsApi } from "./domains/workflows.js";

export const api = {
  agents: agentsApi,
  attachments: attachmentsApi,
  audit: auditApi,
  auth: authApi,
  automation: automationApi,
  chatIntegrations: chatIntegrationsApi,
  codeEvidence: codeEvidenceApi,
  columns: columnsApi,
  comments: commentsApi,
  daemons: daemonsApi,
  dashboard: dashboardApi,
  dependencies: dependenciesApi,
  effort: effortApi,
  habitats: habitatsApi,
  health: healthApi,
  insights: insightsApi,
  integrations: integrationsApi,
  metrics: metricsApi,
  missionComments: missionCommentsApi,
  missions: missionsApi,
  notifications: notificationsApi,
  notificationsV2: notificationsV2Api,
  organizations: organizationsApi,
  plugins: pluginsApi,
  presence: presenceApi,
  pulse: pulseApi,
  qualityGates: qualityGatesApi,
  remoteAccess: remoteAccessApi,
  reviewers: reviewersApi,
  reviewRules: reviewRulesApi,
  savedFilters: savedFiltersApi,
  scheduledTasks: scheduledTasksApi,
  skill: skillApi,
  sprints: sprintsApi,
  subtasks: subtasksApi,
  tasks: tasksApi,
  teams: teamsApi,
  templates: templatesApi,
  timeTracking: timeTrackingApi,
  triage: triageApi,
  wiki: wikiApi,
  workflows: workflowsApi,
  myTeams: teamsApi.myTeams,
};

export type ApiClient = typeof api;
