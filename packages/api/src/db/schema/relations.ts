import { relations } from "drizzle-orm";
import {
  habitats,
  columns,
  missions,
  missionDependencies,
  missionEvents,
  missionWatchers,
  missionComments,
  missionCommentMentions,
  missionTemplates,
  savedFilters,
  chatIntegrations,
  auditExportSchedules,
  scheduledTasks,
  sprints,
} from "./board.js";
import {
  tasks,
  taskEvents,
  taskComments,
  taskSubtasks,
  taskWatchers,
  taskCommentMentions,
  taskAttachments,
  taskTimeRecords,
} from "./task.js";
import { reviewRules, taskReviewers } from "./review.js";
import {
  integrationConnections,
  externalIntakeCandidates,
  externalIssueLinks,
  integrationSyncRuns,
} from "./integration.js";
import { daemonInstances, daemonAgents, daemonSessions } from "./daemon.js";
import { habitatSkills, habitatSkillSignals } from "./habitat-skill.js";
import { agents, agentMessages } from "./agent.js";
import { users, notificationPreferences, organizations, teams, teamMembers } from "./user.js";
import { webhookSubscriptions, webhookDeliveries } from "./webhook.js";
import { pulses } from "./pulse.js";
import { projectInsights } from "./insight.js";
import { pulseReactions } from "./reaction.js";
import { pullRequests, pipelineEvents } from "./cicd.js";
import {
  qualityChecklistTemplates,
  qualityChecklistItems,
  taskQualityChecklists,
  taskQualityChecklistItems,
} from "./quality.js";

export const habitatsRelations = relations(habitats, ({ many, one }) => ({
  columns: many(columns),
  missions: many(missions),
  insights: many(projectInsights),
  sprints: many(sprints),
  reviewRules: many(reviewRules),
  integrationConnections: many(integrationConnections),
  externalIntakeCandidates: many(externalIntakeCandidates),
  externalIssueLinks: many(externalIssueLinks),
  integrationSyncRuns: many(integrationSyncRuns),
  habitatSkills: many(habitatSkills),
  habitatSkillSignals: many(habitatSkillSignals),
  team: one(teams, {
    fields: [habitats.teamId],
    references: [teams.id],
  }),
}));

export const columnsRelations = relations(columns, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [columns.habitatId],
    references: [habitats.id],
  }),
  nextColumn: one(columns, {
    fields: [columns.nextColumnId],
    references: [columns.id],
    relationName: "nextColumn",
  }),
  missions: many(missions),
}));

export const missionsRelations = relations(missions, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [missions.habitatId],
    references: [habitats.id],
  }),
  column: one(columns, {
    fields: [missions.columnId],
    references: [columns.id],
  }),
  sprint: one(sprints, {
    fields: [missions.sprintId],
    references: [sprints.id],
  }),
  tasks: many(tasks),
  events: many(missionEvents),
  watchers: many(missionWatchers),
  dependencies: many(missionDependencies, { relationName: "missionDeps" }),
  dependents: many(missionDependencies, { relationName: "missionDependents" }),
  pulses: many(pulses),
  comments: many(missionComments),
  externalIssueLinks: many(externalIssueLinks),
}));

export const missionDependenciesRelations = relations(missionDependencies, ({ one }) => ({
  mission: one(missions, {
    fields: [missionDependencies.missionId],
    references: [missions.id],
    relationName: "missionDeps",
  }),
  dependsOn: one(missions, {
    fields: [missionDependencies.dependsOnId],
    references: [missions.id],
    relationName: "missionDependents",
  }),
}));

export const missionEventsRelations = relations(missionEvents, ({ one }) => ({
  mission: one(missions, {
    fields: [missionEvents.missionId],
    references: [missions.id],
  }),
}));

export const missionWatchersRelations = relations(missionWatchers, ({ one }) => ({
  mission: one(missions, {
    fields: [missionWatchers.missionId],
    references: [missions.id],
  }),
  user: one(users, {
    fields: [missionWatchers.userId],
    references: [users.id],
  }),
}));

export const missionCommentsRelations = relations(missionComments, ({ one, many }) => ({
  mission: one(missions, {
    fields: [missionComments.missionId],
    references: [missions.id],
  }),
  parent: one(missionComments, {
    fields: [missionComments.parentId],
    references: [missionComments.id],
    relationName: "missionCommentReplies",
  }),
  replies: many(missionComments, { relationName: "missionCommentReplies" }),
  mentions: many(missionCommentMentions),
}));

export const missionCommentMentionsRelations = relations(missionCommentMentions, ({ one }) => ({
  comment: one(missionComments, {
    fields: [missionCommentMentions.commentId],
    references: [missionComments.id],
  }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  assignedTasks: many(tasks, { relationName: "assignedAgent" }),
  delegatedTasks: many(tasks, { relationName: "delegatedAgent" }),
  subtasks: many(taskSubtasks),
  sentMessages: many(agentMessages, { relationName: "fromAgent" }),
  receivedMessages: many(agentMessages, { relationName: "toAgent" }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  mission: one(missions, {
    fields: [tasks.missionId],
    references: [missions.id],
  }),
  assignedAgent: one(agents, {
    fields: [tasks.assignedAgentId],
    references: [agents.id],
    relationName: "assignedAgent",
  }),
  delegatedAgent: one(agents, {
    fields: [tasks.delegatedToAgentId],
    references: [agents.id],
    relationName: "delegatedAgent",
  }),
  events: many(taskEvents),
  comments: many(taskComments),
  subtasks: many(taskSubtasks),
  attachments: many(taskAttachments),
  pullRequests: many(pullRequests),
  pipelineEvents: many(pipelineEvents),
  timeRecords: many(taskTimeRecords),
  qualityChecklists: many(taskQualityChecklists),
  pulses: many(pulses, { relationName: "taskPulses" }),
  linkedPulses: many(pulses, { relationName: "linkedTaskPulses" }),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [taskEvents.taskId],
    references: [tasks.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  comments: many(taskComments),
  missionComments: many(missionComments),
  watchers: many(taskWatchers),
  missionWatchers: many(missionWatchers),
  notificationPreferences: many(notificationPreferences),
  teamMemberships: many(teamMembers),
}));

export const taskCommentsRelations = relations(taskComments, ({ one, many }) => ({
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
  parent: one(taskComments, {
    fields: [taskComments.parentId],
    references: [taskComments.id],
    relationName: "commentReplies",
  }),
  replies: many(taskComments, { relationName: "commentReplies" }),
  mentions: many(taskCommentMentions),
}));

export const missionTemplatesRelations = relations(missionTemplates, ({ one }) => ({
  habitat: one(habitats, {
    fields: [missionTemplates.habitatId],
    references: [habitats.id],
  }),
}));

export const webhookSubscriptionsRelations = relations(webhookSubscriptions, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [webhookSubscriptions.habitatId],
    references: [habitats.id],
  }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  subscription: one(webhookSubscriptions, {
    fields: [webhookDeliveries.subscriptionId],
    references: [webhookSubscriptions.id],
  }),
}));

export const taskSubtasksRelations = relations(taskSubtasks, ({ one }) => ({
  task: one(tasks, {
    fields: [taskSubtasks.taskId],
    references: [tasks.id],
  }),
  assignee: one(agents, {
    fields: [taskSubtasks.assigneeId],
    references: [agents.id],
  }),
}));

export const taskWatchersRelations = relations(taskWatchers, ({ one }) => ({
  task: one(tasks, {
    fields: [taskWatchers.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskWatchers.userId],
    references: [users.id],
  }),
}));

export const taskCommentMentionsRelations = relations(taskCommentMentions, ({ one }) => ({
  comment: one(taskComments, {
    fields: [taskCommentMentions.commentId],
    references: [taskComments.id],
  }),
}));

export const savedFiltersRelations = relations(savedFilters, ({ one }) => ({
  habitat: one(habitats, {
    fields: [savedFilters.habitatId],
    references: [habitats.id],
  }),
}));

export const taskAttachmentsRelations = relations(taskAttachments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskAttachments.taskId],
    references: [tasks.id],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  habitat: one(habitats, {
    fields: [notificationPreferences.habitatId],
    references: [habitats.id],
  }),
}));

export const chatIntegrationsRelations = relations(chatIntegrations, ({ one }) => ({
  habitat: one(habitats, {
    fields: [chatIntegrations.habitatId],
    references: [habitats.id],
  }),
}));

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  habitat: one(habitats, {
    fields: [agentMessages.habitatId],
    references: [habitats.id],
  }),
  fromAgent: one(agents, {
    fields: [agentMessages.fromAgentId],
    references: [agents.id],
    relationName: "fromAgent",
  }),
  toAgent: one(agents, {
    fields: [agentMessages.toAgentId],
    references: [agents.id],
    relationName: "toAgent",
  }),
  task: one(tasks, {
    fields: [agentMessages.taskId],
    references: [tasks.id],
  }),
}));

export const pulsesRelations = relations(pulses, ({ one, many }) => ({
  mission: one(missions, {
    fields: [pulses.missionId],
    references: [missions.id],
  }),
  habitat: one(habitats, {
    fields: [pulses.habitatId],
    references: [habitats.id],
  }),
  task: one(tasks, {
    fields: [pulses.taskId],
    references: [tasks.id],
    relationName: "taskPulses",
  }),
  linkedTask: one(tasks, {
    fields: [pulses.linkedTaskId],
    references: [tasks.id],
    relationName: "linkedTaskPulses",
  }),
  replyTo: one(pulses, {
    fields: [pulses.replyToId],
    references: [pulses.id],
    relationName: "pulseThread",
  }),
  replies: many(pulses, { relationName: "pulseThread" }),
  reactions: many(pulseReactions),
}));

export const pullRequestsRelations = relations(pullRequests, ({ one }) => ({
  task: one(tasks, {
    fields: [pullRequests.taskId],
    references: [tasks.id],
  }),
}));

export const pipelineEventsRelations = relations(pipelineEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [pipelineEvents.taskId],
    references: [tasks.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  teams: many(teams),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [teams.organizationId],
    references: [organizations.id],
  }),
  habitats: many(habitats),
  members: many(teamMembers),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}));

export const taskTimeRecordsRelations = relations(taskTimeRecords, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTimeRecords.taskId],
    references: [tasks.id],
  }),
  agent: one(agents, {
    fields: [taskTimeRecords.agentId],
    references: [agents.id],
  }),
}));

export const qualityChecklistTemplatesRelations = relations(
  qualityChecklistTemplates,
  ({ many }) => ({
    items: many(qualityChecklistItems),
    taskChecklists: many(taskQualityChecklists),
  }),
);

export const qualityChecklistItemsRelations = relations(qualityChecklistItems, ({ one }) => ({
  template: one(qualityChecklistTemplates, {
    fields: [qualityChecklistItems.templateId],
    references: [qualityChecklistTemplates.id],
  }),
}));

export const taskQualityChecklistsRelations = relations(taskQualityChecklists, ({ one, many }) => ({
  task: one(tasks, {
    fields: [taskQualityChecklists.taskId],
    references: [tasks.id],
  }),
  template: one(qualityChecklistTemplates, {
    fields: [taskQualityChecklists.templateId],
    references: [qualityChecklistTemplates.id],
  }),
  items: many(taskQualityChecklistItems),
}));

export const taskQualityChecklistItemsRelations = relations(
  taskQualityChecklistItems,
  ({ one }) => ({
    checklist: one(taskQualityChecklists, {
      fields: [taskQualityChecklistItems.checklistId],
      references: [taskQualityChecklists.id],
    }),
    item: one(qualityChecklistItems, {
      fields: [taskQualityChecklistItems.itemId],
      references: [qualityChecklistItems.id],
    }),
  }),
);

export const projectInsightsRelations = relations(projectInsights, ({ one }) => ({
  habitat: one(habitats, {
    fields: [projectInsights.habitatId],
    references: [habitats.id],
  }),
  sourcePulse: one(pulses, {
    fields: [projectInsights.sourcePulseId],
    references: [pulses.id],
  }),
}));

export const pulsesReactionsRelations = relations(pulseReactions, ({ one }) => ({
  pulse: one(pulses, {
    fields: [pulseReactions.pulseId],
    references: [pulses.id],
  }),
}));

export const auditExportSchedulesRelations = relations(auditExportSchedules, ({ one }) => ({
  habitat: one(habitats, {
    fields: [auditExportSchedules.habitatId],
    references: [habitats.id],
  }),
}));

export const scheduledTasksRelations = relations(scheduledTasks, ({ one }) => ({
  habitat: one(habitats, {
    fields: [scheduledTasks.habitatId],
    references: [habitats.id],
  }),
  template: one(missionTemplates, {
    fields: [scheduledTasks.templateId],
    references: [missionTemplates.id],
  }),
}));

export const sprintsRelations = relations(sprints, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [sprints.habitatId],
    references: [habitats.id],
  }),
  missions: many(missions),
}));

export const reviewRulesRelations = relations(reviewRules, ({ one }) => ({
  habitat: one(habitats, {
    fields: [reviewRules.habitatId],
    references: [habitats.id],
  }),
}));

export const taskReviewersRelations = relations(taskReviewers, ({ one }) => ({
  task: one(tasks, {
    fields: [taskReviewers.taskId],
    references: [tasks.id],
  }),
}));

export const integrationConnectionsRelations = relations(
  integrationConnections,
  ({ one, many }) => ({
    habitat: one(habitats, {
      fields: [integrationConnections.habitatId],
      references: [habitats.id],
    }),
    externalIssueLinks: many(externalIssueLinks),
    externalIntakeCandidates: many(externalIntakeCandidates),
    syncRuns: many(integrationSyncRuns),
  }),
);

export const externalIntakeCandidatesRelations = relations(externalIntakeCandidates, ({ one }) => ({
  connection: one(integrationConnections, {
    fields: [externalIntakeCandidates.connectionId],
    references: [integrationConnections.id],
  }),
  habitat: one(habitats, {
    fields: [externalIntakeCandidates.habitatId],
    references: [habitats.id],
  }),
  promotedMission: one(missions, {
    fields: [externalIntakeCandidates.promotedMissionId],
    references: [missions.id],
  }),
}));

export const externalIssueLinksRelations = relations(externalIssueLinks, ({ one }) => ({
  connection: one(integrationConnections, {
    fields: [externalIssueLinks.connectionId],
    references: [integrationConnections.id],
  }),
  habitat: one(habitats, {
    fields: [externalIssueLinks.habitatId],
    references: [habitats.id],
  }),
  mission: one(missions, {
    fields: [externalIssueLinks.missionId],
    references: [missions.id],
  }),
}));

export const integrationSyncRunsRelations = relations(integrationSyncRuns, ({ one }) => ({
  connection: one(integrationConnections, {
    fields: [integrationSyncRuns.connectionId],
    references: [integrationConnections.id],
  }),
  habitat: one(habitats, {
    fields: [integrationSyncRuns.habitatId],
    references: [habitats.id],
  }),
}));

export const daemonInstancesRelations = relations(daemonInstances, ({ many }) => ({
  daemonAgents: many(daemonAgents),
  daemonSessions: many(daemonSessions),
}));

export const daemonAgentsRelations = relations(daemonAgents, ({ one }) => ({
  daemon: one(daemonInstances, {
    fields: [daemonAgents.daemonId],
    references: [daemonInstances.id],
  }),
  agent: one(agents, {
    fields: [daemonAgents.agentId],
    references: [agents.id],
  }),
}));

export const daemonSessionsRelations = relations(daemonSessions, ({ one }) => ({
  daemon: one(daemonInstances, {
    fields: [daemonSessions.daemonId],
    references: [daemonInstances.id],
  }),
  agent: one(agents, {
    fields: [daemonSessions.agentId],
    references: [agents.id],
  }),
  task: one(tasks, {
    fields: [daemonSessions.taskId],
    references: [tasks.id],
  }),
  habitat: one(habitats, {
    fields: [daemonSessions.habitatId],
    references: [habitats.id],
  }),
}));

export const habitatSkillsRelations = relations(habitatSkills, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [habitatSkills.habitatId],
    references: [habitats.id],
  }),
  signals: many(habitatSkillSignals, {
    relationName: "skillSignals",
  }),
}));

export const habitatSkillSignalsRelations = relations(habitatSkillSignals, ({ one }) => ({
  habitat: one(habitats, {
    fields: [habitatSkillSignals.habitatId],
    references: [habitats.id],
  }),
  skill: one(habitatSkills, {
    fields: [habitatSkillSignals.habitatId],
    references: [habitatSkills.habitatId],
    relationName: "skillSignals",
  }),
}));
