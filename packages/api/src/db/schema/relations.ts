import { relations } from 'drizzle-orm';
import { boards, columns, features, featureDependencies, featureEvents, featureWatchers, featureTemplates, savedFilters, chatIntegrations, featureComments, featureCommentMentions, auditExportSchedules, scheduledTasks, boardHealthSnapshots } from './board.js';
import { tasks, taskEvents, taskComments, taskSubtasks, taskWatchers, taskCommentMentions, taskAttachments, taskTimeRecords } from './task.js';
import { agents, agentMessages } from './agent.js';
import { users, notificationPreferences, organizations, teams, teamMembers } from './user.js';
import { webhookSubscriptions, webhookDeliveries } from './webhook.js';
import { pulses, pulseCursors } from './pulse.js';
import { projectInsights } from './insight.js';
import { pulseReactions } from './reaction.js';
import { pullRequests, pipelineEvents } from './cicd.js';
import { qualityChecklistTemplates, qualityChecklistItems, taskQualityChecklists, taskQualityChecklistItems } from './quality.js';

export const boardsRelations = relations(boards, ({ many, one }) => ({
  columns: many(columns),
  features: many(features),
  insights: many(projectInsights),
  team: one(teams, {
    fields: [boards.teamId],
    references: [teams.id],
  }),
}));

export const columnsRelations = relations(columns, ({ one, many }) => ({
  board: one(boards, {
    fields: [columns.boardId],
    references: [boards.id],
  }),
  nextColumn: one(columns, {
    fields: [columns.nextColumnId],
    references: [columns.id],
    relationName: 'nextColumn',
  }),
  features: many(features),
}));

export const featuresRelations = relations(features, ({ one, many }) => ({
  board: one(boards, {
    fields: [features.boardId],
    references: [boards.id],
  }),
  column: one(columns, {
    fields: [features.columnId],
    references: [columns.id],
  }),
  tasks: many(tasks),
  events: many(featureEvents),
  watchers: many(featureWatchers),
  dependencies: many(featureDependencies, { relationName: 'featureDeps' }),
  dependents: many(featureDependencies, { relationName: 'featureDependents' }),
  pulses: many(pulses),
  comments: many(featureComments),
}));

export const featureDependenciesRelations = relations(featureDependencies, ({ one }) => ({
  feature: one(features, {
    fields: [featureDependencies.featureId],
    references: [features.id],
    relationName: 'featureDeps',
  }),
  dependsOn: one(features, {
    fields: [featureDependencies.dependsOnId],
    references: [features.id],
    relationName: 'featureDependents',
  }),
}));

export const featureEventsRelations = relations(featureEvents, ({ one }) => ({
  feature: one(features, {
    fields: [featureEvents.featureId],
    references: [features.id],
  }),
}));

export const featureWatchersRelations = relations(featureWatchers, ({ one }) => ({
  feature: one(features, {
    fields: [featureWatchers.featureId],
    references: [features.id],
  }),
  user: one(users, {
    fields: [featureWatchers.userId],
    references: [users.id],
  }),
}));

export const featureCommentsRelations = relations(featureComments, ({ one, many }) => ({
  feature: one(features, {
    fields: [featureComments.featureId],
    references: [features.id],
  }),
  parent: one(featureComments, {
    fields: [featureComments.parentId],
    references: [featureComments.id],
    relationName: 'featureCommentReplies',
  }),
  replies: many(featureComments, { relationName: 'featureCommentReplies' }),
  mentions: many(featureCommentMentions),
}));

export const featureCommentMentionsRelations = relations(featureCommentMentions, ({ one }) => ({
  comment: one(featureComments, {
    fields: [featureCommentMentions.commentId],
    references: [featureComments.id],
  }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  assignedTasks: many(tasks, { relationName: 'assignedAgent' }),
  delegatedTasks: many(tasks, { relationName: 'delegatedAgent' }),
  subtasks: many(taskSubtasks),
  sentMessages: many(agentMessages, { relationName: 'fromAgent' }),
  receivedMessages: many(agentMessages, { relationName: 'toAgent' }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  feature: one(features, {
    fields: [tasks.featureId],
    references: [features.id],
  }),
  assignedAgent: one(agents, {
    fields: [tasks.assignedAgentId],
    references: [agents.id],
    relationName: 'assignedAgent',
  }),
  delegatedAgent: one(agents, {
    fields: [tasks.delegatedToAgentId],
    references: [agents.id],
    relationName: 'delegatedAgent',
  }),
  events: many(taskEvents),
  comments: many(taskComments),
  subtasks: many(taskSubtasks),
  attachments: many(taskAttachments),
  pullRequests: many(pullRequests),
  pipelineEvents: many(pipelineEvents),
  timeRecords: many(taskTimeRecords),
  qualityChecklists: many(taskQualityChecklists),
  pulses: many(pulses, { relationName: 'taskPulses' }),
  linkedPulses: many(pulses, { relationName: 'linkedTaskPulses' }),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [taskEvents.taskId],
    references: [tasks.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  comments: many(taskComments),
  featureComments: many(featureComments),
  watchers: many(taskWatchers),
  featureWatchers: many(featureWatchers),
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
    relationName: 'commentReplies',
  }),
  replies: many(taskComments, { relationName: 'commentReplies' }),
  mentions: many(taskCommentMentions),
}));

export const featureTemplatesRelations = relations(featureTemplates, ({ one }) => ({
  board: one(boards, {
    fields: [featureTemplates.boardId],
    references: [boards.id],
  }),
}));

export const webhookSubscriptionsRelations = relations(webhookSubscriptions, ({ one, many }) => ({
  board: one(boards, {
    fields: [webhookSubscriptions.boardId],
    references: [boards.id],
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
  board: one(boards, {
    fields: [savedFilters.boardId],
    references: [boards.id],
  }),
}));

export const taskAttachmentsRelations = relations(taskAttachments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskAttachments.taskId],
    references: [tasks.id],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  board: one(boards, {
    fields: [notificationPreferences.boardId],
    references: [boards.id],
  }),
}));

export const chatIntegrationsRelations = relations(chatIntegrations, ({ one }) => ({
  board: one(boards, {
    fields: [chatIntegrations.boardId],
    references: [boards.id],
  }),
}));

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  board: one(boards, {
    fields: [agentMessages.boardId],
    references: [boards.id],
  }),
  fromAgent: one(agents, {
    fields: [agentMessages.fromAgentId],
    references: [agents.id],
    relationName: 'fromAgent',
  }),
  toAgent: one(agents, {
    fields: [agentMessages.toAgentId],
    references: [agents.id],
    relationName: 'toAgent',
  }),
  task: one(tasks, {
    fields: [agentMessages.taskId],
    references: [tasks.id],
  }),
}));

export const pulsesRelations = relations(pulses, ({ one, many }) => ({
  mission: one(features, {
    fields: [pulses.missionId],
    references: [features.id],
  }),
  board: one(boards, {
    fields: [pulses.boardId],
    references: [boards.id],
  }),
  task: one(tasks, {
    fields: [pulses.taskId],
    references: [tasks.id],
    relationName: 'taskPulses',
  }),
  linkedTask: one(tasks, {
    fields: [pulses.linkedTaskId],
    references: [tasks.id],
    relationName: 'linkedTaskPulses',
  }),
  replyTo: one(pulses, {
    fields: [pulses.replyToId],
    references: [pulses.id],
    relationName: 'pulseThread',
  }),
  replies: many(pulses, { relationName: 'pulseThread' }),
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
  boards: many(boards),
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

export const qualityChecklistTemplatesRelations = relations(qualityChecklistTemplates, ({ many }) => ({
  items: many(qualityChecklistItems),
  taskChecklists: many(taskQualityChecklists),
}));

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

export const taskQualityChecklistItemsRelations = relations(taskQualityChecklistItems, ({ one }) => ({
  checklist: one(taskQualityChecklists, {
    fields: [taskQualityChecklistItems.checklistId],
    references: [taskQualityChecklists.id],
  }),
  item: one(qualityChecklistItems, {
    fields: [taskQualityChecklistItems.itemId],
    references: [qualityChecklistItems.id],
  }),
}));

export const boardsProjectInsightsRelations = relations(projectInsights, ({ one }) => ({
  board: one(boards, {
    fields: [projectInsights.boardId],
    references: [boards.id],
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
  board: one(boards, {
    fields: [auditExportSchedules.boardId],
    references: [boards.id],
  }),
}));

export const scheduledTasksRelations = relations(scheduledTasks, ({ one }) => ({
  board: one(boards, {
    fields: [scheduledTasks.boardId],
    references: [boards.id],
  }),
  template: one(featureTemplates, {
    fields: [scheduledTasks.templateId],
    references: [featureTemplates.id],
  }),
}));
