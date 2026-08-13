import { z } from "zod";
import {
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_SCAN_TYPES,
} from "@orcy/shared";
import { automationConditionSchema } from "./automationConditionSchema.js";

/** Resolvable recipient for automation notifications. */
export const automationRecipientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assignee") }),
  z.object({ type: z.literal("reporter") }),
  z.object({ type: z.literal("reviewers") }),
  z.object({ type: z.literal("mission_owner") }),
  z.object({ type: z.literal("habitat_admins") }),
  z.object({ type: z.literal("agent"), agentId: z.string().min(1) }),
  z.object({ type: z.literal("human"), userId: z.string().min(1) }),
  z.object({ type: z.literal("channel"), channelId: z.string().min(1) }),
]);

/** Strict discriminated schema for automation rule triggers (events vs scans). */
export const automationTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    eventType: z.enum(AUTOMATION_EVENT_TYPES),
  }),
  z.object({
    type: z.literal("scan"),
    scanType: z.enum(AUTOMATION_SCAN_TYPES),
  }),
]);

/** Strict discriminated schema for all concrete automation actions. */
export const automationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    recipients: z.array(automationRecipientSchema).min(1),
    template: z.string().min(1),
    channels: z.array(z.string().min(1)).optional(),
    severity: z.string().optional(),
  }),
  z.object({
    type: z.literal("create_signal"),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("create_task"),
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    missionId: z.string().optional(),
    assignedTo: z
      .object({
        recipientType: z.string().min(1),
        recipientId: z.string().min(1),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("change_priority"),
    priority: z.string().min(1),
  }),
  z.object({
    type: z.literal("assign"),
    recipientType: z.string().min(1),
    recipientId: z.string().min(1),
  }),
  z.object({
    type: z.literal("release_assignment"),
  }),
  z.object({
    type: z.literal("request_review"),
    reviewerType: z.string().optional(),
    reviewerId: z.string().optional(),
  }),
  z.object({
    type: z.literal("call_webhook"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    bodyTemplate: z.string().optional(),
  }),
  z.object({
    type: z.literal("mark_risk"),
    level: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("plugin"),
    actionId: z.string().min(1),
    params: z.record(z.unknown()).optional(),
  }),
]);

/** Schema for creating an automation rule or validating a rule draft. */
export const createAutomationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().nonnegative().optional(),
  trigger: automationTriggerSchema,
  condition: automationConditionSchema.optional(),
  actions: z.array(automationActionSchema).min(1).max(10),
  cooldownSeconds: z.number().int().nonnegative().optional(),
  maxRunsPerHour: z.number().int().positive().optional(),
});

/** Schema for updating an existing automation rule. */
export const updateAutomationRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().nonnegative().optional(),
  trigger: automationTriggerSchema.optional(),
  condition: automationConditionSchema.optional(),
  actions: z.array(automationActionSchema).min(1).max(10).optional(),
  cooldownSeconds: z.number().int().nonnegative().optional(),
  maxRunsPerHour: z.number().int().positive().optional(),
});

/** Schema for machine-readable authoring drafts (LL-RM-1). */
export const automationRuleDraftSchema = createAutomationRuleSchema;
