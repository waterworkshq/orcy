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
  habitatHealthSnapshots,
  cumulativeFlowSnapshots,
} from "./habitat.js";
import {
  tasks,
  taskEvents,
  taskComments,
  taskSubtasks,
  taskWatchers,
  taskCommentMentions,
  taskAttachments,
  taskTimeRecords,
  effortEntries,
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
import {
  notificationEvents,
  notificationDeliveries,
  notificationDeliveryAttempts,
  notificationSubscriptions,
  notificationDigestItems,
  notificationRetentionPolicies,
} from "./notification.js";
import { automationRules, automationRuleRuns } from "./automation.js";
import {
  identityProviders,
  identityProviderAuthStates,
  externalIdentities,
  remoteInvites,
  remotePods,
  remoteParticipants,
  remoteCredentials,
  remoteGrants,
  remoteGrantTargets,
  remoteGrantRules,
  remoteGrantTaskSnapshots,
  remoteIdempotencyKeys,
  remoteWebhookEndpoints,
} from "./remote-pod.js";
import { agents, agentMessages } from "./agent.js";
import { users, notificationPreferences, organizations, teams, teamMembers } from "./user.js";
import { webhookSubscriptions, webhookDeliveries } from "./webhook.js";
import { pulses } from "./pulse.js";
import { projectInsights } from "./insight.js";
import { pulseReactions } from "./reaction.js";
import { pullRequests, pipelineEvents } from "./cicd.js";
import {
  habitatCodeRepositories,
  codeBranches,
  codeCommits,
  codeChangedFiles,
  codeReviews,
  codeEvidenceLinks,
  codeEvidenceCompleteness,
  codeEvidenceGaps,
} from "./code-evidence.js";
import {
  qualityChecklistTemplates,
  qualityChecklistItems,
  taskQualityChecklists,
  taskQualityChecklistItems,
} from "./quality.js";
import { findingTriage, triageResolutions, triageClusterMissions } from "./triage.js";
import { releases } from "./release.js";
import {
  taskCreationAttempts,
  taskCreationGovernanceDecisions,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
  missionRecalculationMarkers,
  scheduledOccurrences,
} from "./taskPublication.js";

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
  codeRepository: one(habitatCodeRepositories, {
    fields: [habitats.id],
    references: [habitatCodeRepositories.habitatId],
  }),
  healthSnapshots: many(habitatHealthSnapshots),
  cumulativeFlowSnapshots: many(cumulativeFlowSnapshots),
  notificationEvents: many(notificationEvents),
  notificationDeliveries: many(notificationDeliveries),
  notificationSubscriptions: many(notificationSubscriptions),
  notificationRetentionPolicy: one(notificationRetentionPolicies, {
    fields: [habitats.id],
    references: [notificationRetentionPolicies.habitatId],
  }),
  automationRules: many(automationRules),
  automationRuleRuns: many(automationRuleRuns),
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
  effortEntries: many(effortEntries),
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
  repository: one(habitatCodeRepositories, {
    fields: [pullRequests.repositoryId],
    references: [habitatCodeRepositories.id],
  }),
  branch: one(codeBranches, {
    fields: [pullRequests.branchId],
    references: [codeBranches.id],
  }),
}));

export const pipelineEventsRelations = relations(pipelineEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [pipelineEvents.taskId],
    references: [tasks.id],
  }),
  repository: one(habitatCodeRepositories, {
    fields: [pipelineEvents.repositoryId],
    references: [habitatCodeRepositories.id],
  }),
  commit: one(codeCommits, {
    fields: [pipelineEvents.commitId],
    references: [codeCommits.id],
  }),
  branchEvidence: one(codeBranches, {
    fields: [pipelineEvents.branchEvidenceId],
    references: [codeBranches.id],
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

export const effortEntriesRelations = relations(effortEntries, ({ one, many }) => ({
  task: one(tasks, {
    fields: [effortEntries.taskId],
    references: [tasks.id],
  }),
  correctedEntry: one(effortEntries, {
    fields: [effortEntries.correctsEntryId],
    references: [effortEntries.id],
    relationName: "effortCorrection",
  }),
  corrections: many(effortEntries, { relationName: "effortCorrection" }),
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

export const habitatCodeRepositoriesRelations = relations(
  habitatCodeRepositories,
  ({ one, many }) => ({
    habitat: one(habitats, {
      fields: [habitatCodeRepositories.habitatId],
      references: [habitats.id],
    }),
    branches: many(codeBranches),
    commits: many(codeCommits),
    changedFiles: many(codeChangedFiles),
    reviews: many(codeReviews),
  }),
);

export const codeBranchesRelations = relations(codeBranches, ({ one, many }) => ({
  repository: one(habitatCodeRepositories, {
    fields: [codeBranches.repositoryId],
    references: [habitatCodeRepositories.id],
  }),
  createdFromTask: one(tasks, {
    fields: [codeBranches.createdFromTaskId],
    references: [tasks.id],
  }),
  commits: many(codeCommits),
}));

export const codeCommitsRelations = relations(codeCommits, ({ one, many }) => ({
  repository: one(habitatCodeRepositories, {
    fields: [codeCommits.repositoryId],
    references: [habitatCodeRepositories.id],
  }),
  branch: one(codeBranches, {
    fields: [codeCommits.branchId],
    references: [codeBranches.id],
  }),
  changedFiles: many(codeChangedFiles),
}));

export const codeChangedFilesRelations = relations(codeChangedFiles, ({ one }) => ({
  repository: one(habitatCodeRepositories, {
    fields: [codeChangedFiles.repositoryId],
    references: [habitatCodeRepositories.id],
  }),
  commit: one(codeCommits, {
    fields: [codeChangedFiles.commitId],
    references: [codeCommits.id],
  }),
  pullRequest: one(pullRequests, {
    fields: [codeChangedFiles.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const codeReviewsRelations = relations(codeReviews, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [codeReviews.pullRequestId],
    references: [pullRequests.id],
  }),
  repository: one(habitatCodeRepositories, {
    fields: [codeReviews.repositoryId],
    references: [habitatCodeRepositories.id],
  }),
}));

export const codeEvidenceLinksRelations = relations(codeEvidenceLinks, ({ one }) => ({
  replacementLink: one(codeEvidenceLinks, {
    fields: [codeEvidenceLinks.replacementLinkId],
    references: [codeEvidenceLinks.id],
    relationName: "evidenceReplacement",
  }),
}));

export const codeEvidenceCompletenessRelations = relations(codeEvidenceCompleteness, () => ({}));

export const codeEvidenceGapsRelations = relations(codeEvidenceGaps, () => ({}));

export const habitatHealthSnapshotsRelations = relations(habitatHealthSnapshots, ({ one }) => ({
  habitat: one(habitats, {
    fields: [habitatHealthSnapshots.habitatId],
    references: [habitats.id],
  }),
}));

export const cumulativeFlowSnapshotsRelations = relations(cumulativeFlowSnapshots, ({ one }) => ({
  habitat: one(habitats, {
    fields: [cumulativeFlowSnapshots.habitatId],
    references: [habitats.id],
  }),
}));

export const notificationEventsRelations = relations(notificationEvents, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [notificationEvents.habitatId],
    references: [habitats.id],
  }),
  deliveries: many(notificationDeliveries),
}));

export const notificationDeliveriesRelations = relations(
  notificationDeliveries,
  ({ one, many }) => ({
    event: one(notificationEvents, {
      fields: [notificationDeliveries.eventId],
      references: [notificationEvents.id],
    }),
    habitat: one(habitats, {
      fields: [notificationDeliveries.habitatId],
      references: [habitats.id],
    }),
    attempts: many(notificationDeliveryAttempts),
  }),
);

export const notificationDeliveryAttemptsRelations = relations(
  notificationDeliveryAttempts,
  ({ one }) => ({
    delivery: one(notificationDeliveries, {
      fields: [notificationDeliveryAttempts.deliveryId],
      references: [notificationDeliveries.id],
    }),
  }),
);

export const notificationSubscriptionsRelations = relations(
  notificationSubscriptions,
  ({ one }) => ({
    habitat: one(habitats, {
      fields: [notificationSubscriptions.habitatId],
      references: [habitats.id],
    }),
  }),
);

export const notificationDigestItemsRelations = relations(notificationDigestItems, ({ one }) => ({
  digestEvent: one(notificationEvents, {
    fields: [notificationDigestItems.digestEventId],
    references: [notificationEvents.id],
    relationName: "digestEvent",
  }),
  includedEvent: one(notificationEvents, {
    fields: [notificationDigestItems.includedEventId],
    references: [notificationEvents.id],
    relationName: "includedEvent",
  }),
  includedDelivery: one(notificationDeliveries, {
    fields: [notificationDigestItems.includedDeliveryId],
    references: [notificationDeliveries.id],
  }),
}));

export const notificationRetentionPoliciesRelations = relations(
  notificationRetentionPolicies,
  ({ one }) => ({
    habitat: one(habitats, {
      fields: [notificationRetentionPolicies.habitatId],
      references: [habitats.id],
    }),
  }),
);

export const automationRulesRelations = relations(automationRules, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [automationRules.habitatId],
    references: [habitats.id],
  }),
  runs: many(automationRuleRuns),
}));

export const automationRuleRunsRelations = relations(automationRuleRuns, ({ one }) => ({
  rule: one(automationRules, {
    fields: [automationRuleRuns.ruleId],
    references: [automationRules.id],
  }),
  habitat: one(habitats, {
    fields: [automationRuleRuns.habitatId],
    references: [habitats.id],
  }),
}));

// ---------------------------------------------------------------------------
// Pod Bridge (v0.19)
// ---------------------------------------------------------------------------

export const identityProvidersRelations = relations(identityProviders, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [identityProviders.habitatId],
    references: [habitats.id],
  }),
  authStates: many(identityProviderAuthStates),
  externalIdentities: many(externalIdentities),
}));

export const identityProviderAuthStatesRelations = relations(
  identityProviderAuthStates,
  ({ one }) => ({
    provider: one(identityProviders, {
      fields: [identityProviderAuthStates.providerId],
      references: [identityProviders.id],
    }),
    habitat: one(habitats, {
      fields: [identityProviderAuthStates.habitatId],
      references: [habitats.id],
    }),
  }),
);

export const externalIdentitiesRelations = relations(externalIdentities, ({ one }) => ({
  provider: one(identityProviders, {
    fields: [externalIdentities.providerId],
    references: [identityProviders.id],
  }),
  habitat: one(habitats, {
    fields: [externalIdentities.habitatId],
    references: [habitats.id],
  }),
  localUser: one(users, {
    fields: [externalIdentities.localUserId],
    references: [users.id],
  }),
}));

export const remoteInvitesRelations = relations(remoteInvites, ({ one }) => ({
  habitat: one(habitats, {
    fields: [remoteInvites.habitatId],
    references: [habitats.id],
  }),
}));

export const remotePodsRelations = relations(remotePods, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [remotePods.habitatId],
    references: [habitats.id],
  }),
  participants: many(remoteParticipants),
  grants: many(remoteGrants),
  webhookEndpoints: many(remoteWebhookEndpoints),
}));

export const remoteParticipantsRelations = relations(remoteParticipants, ({ one, many }) => ({
  remotePod: one(remotePods, {
    fields: [remoteParticipants.remotePodId],
    references: [remotePods.id],
  }),
  habitat: one(habitats, {
    fields: [remoteParticipants.habitatId],
    references: [habitats.id],
  }),
  credentials: many(remoteCredentials),
}));

export const remoteCredentialsRelations = relations(remoteCredentials, ({ one }) => ({
  remoteParticipant: one(remoteParticipants, {
    fields: [remoteCredentials.remoteParticipantId],
    references: [remoteParticipants.id],
  }),
  habitat: one(habitats, {
    fields: [remoteCredentials.habitatId],
    references: [habitats.id],
  }),
}));

export const remoteGrantsRelations = relations(remoteGrants, ({ one, many }) => ({
  habitat: one(habitats, {
    fields: [remoteGrants.habitatId],
    references: [habitats.id],
  }),
  remotePod: one(remotePods, {
    fields: [remoteGrants.remotePodId],
    references: [remotePods.id],
  }),
  remoteParticipant: one(remoteParticipants, {
    fields: [remoteGrants.remoteParticipantId],
    references: [remoteParticipants.id],
  }),
  targets: many(remoteGrantTargets),
  rules: many(remoteGrantRules),
  taskSnapshots: many(remoteGrantTaskSnapshots),
}));

export const remoteGrantTargetsRelations = relations(remoteGrantTargets, ({ one }) => ({
  grant: one(remoteGrants, {
    fields: [remoteGrantTargets.grantId],
    references: [remoteGrants.id],
  }),
}));

export const remoteGrantRulesRelations = relations(remoteGrantRules, ({ one }) => ({
  grant: one(remoteGrants, {
    fields: [remoteGrantRules.grantId],
    references: [remoteGrants.id],
  }),
}));

export const remoteGrantTaskSnapshotsRelations = relations(remoteGrantTaskSnapshots, ({ one }) => ({
  grant: one(remoteGrants, {
    fields: [remoteGrantTaskSnapshots.grantId],
    references: [remoteGrants.id],
  }),
}));

export const remoteIdempotencyKeysRelations = relations(remoteIdempotencyKeys, ({ one }) => ({
  habitat: one(habitats, {
    fields: [remoteIdempotencyKeys.habitatId],
    references: [habitats.id],
  }),
}));

export const remoteWebhookEndpointsRelations = relations(remoteWebhookEndpoints, ({ one }) => ({
  remotePod: one(remotePods, {
    fields: [remoteWebhookEndpoints.remotePodId],
    references: [remotePods.id],
  }),
  habitat: one(habitats, {
    fields: [remoteWebhookEndpoints.habitatId],
    references: [habitats.id],
  }),
}));

export const findingTriageRelations = relations(findingTriage, ({ one }) => ({
  habitat: one(habitats, {
    fields: [findingTriage.habitatId],
    references: [habitats.id],
  }),
  pulse: one(pulses, {
    fields: [findingTriage.pulseId],
    references: [pulses.id],
  }),
  triageMission: one(missions, {
    fields: [findingTriage.triageMissionId],
    references: [missions.id],
  }),
}));

export const triageResolutionsRelations = relations(triageResolutions, ({ one }) => ({
  habitat: one(habitats, {
    fields: [triageResolutions.habitatId],
    references: [habitats.id],
  }),
}));

export const triageClusterMissionsRelations = relations(triageClusterMissions, ({ one }) => ({
  habitat: one(habitats, {
    fields: [triageClusterMissions.habitatId],
    references: [habitats.id],
  }),
  mission: one(missions, {
    fields: [triageClusterMissions.missionId],
    references: [missions.id],
  }),
}));

export const releasesRelations = relations(releases, ({ one }) => ({
  habitat: one(habitats, {
    fields: [releases.habitatId],
    references: [habitats.id],
  }),
}));

// ---------------------------------------------------------------------------
// Task Publication (T1 — dormant; within-family relations only)
// ---------------------------------------------------------------------------
// Cross-chain references (committed_task_id, mission_id, etc.) are intentionally
// NOT modeled as relations: they are plain-text audit refs that outlive habitat
// replacement and may dangle by design.

export const taskCreationAttemptsRelations = relations(taskCreationAttempts, ({ many }) => ({
  governanceDecisions: many(taskCreationGovernanceDecisions),
  envelopes: many(taskCreationEnvelopes),
  reservations: many(taskCreationAssignmentReservations),
}));

export const taskCreationGovernanceDecisionsRelations = relations(
  taskCreationGovernanceDecisions,
  ({ one }) => ({
    attempt: one(taskCreationAttempts, {
      fields: [taskCreationGovernanceDecisions.attemptId],
      references: [taskCreationAttempts.id],
    }),
  }),
);

export const taskCreationEnvelopesRelations = relations(taskCreationEnvelopes, ({ one, many }) => ({
  attempt: one(taskCreationAttempts, {
    fields: [taskCreationEnvelopes.attemptId],
    references: [taskCreationAttempts.id],
  }),
  dispatchTargets: many(taskCreationDispatchTargets),
}));

export const taskCreationDispatchTargetsRelations = relations(
  taskCreationDispatchTargets,
  ({ one }) => ({
    envelope: one(taskCreationEnvelopes, {
      fields: [taskCreationDispatchTargets.eventId],
      references: [taskCreationEnvelopes.eventId],
    }),
  }),
);

export const taskCreationAssignmentReservationsRelations = relations(
  taskCreationAssignmentReservations,
  ({ one }) => ({
    attempt: one(taskCreationAttempts, {
      fields: [taskCreationAssignmentReservations.attemptId],
      references: [taskCreationAttempts.id],
    }),
  }),
);

export const missionRecalculationMarkersRelations = relations(
  missionRecalculationMarkers,
  () => ({}),
);

export const scheduledOccurrencesRelations = relations(scheduledOccurrences, ({ one }) => ({
  attempt: one(taskCreationAttempts, {
    fields: [scheduledOccurrences.attemptId],
    references: [taskCreationAttempts.id],
  }),
}));
