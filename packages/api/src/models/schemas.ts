import { z } from 'zod';

export const exportQuerySchema = z.object({
  include: z.string().optional().default('columns,features,comments,templates,webhooks'),
  format: z.enum(['full', 'features-only']).optional().default('full'),
  status: z.string().optional(),
});

export const createFeatureSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(''),
  acceptanceCriteria: z.string().max(10000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  labels: z.array(z.string()).default([]),
  dependsOn: z.array(z.string().uuid()).default([]),
  blocks: z.array(z.string().uuid()).default([]),
  dueAt: z.string().datetime().optional(),
  slaMinutes: z.number().int().positive().optional(),
  columnId: z.string().uuid().optional(),
});

export const updateFeatureSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  labels: z.array(z.string()).optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
  blocks: z.array(z.string().uuid()).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  slaMinutes: z.number().int().positive().nullable().optional(),
  version: z.number().int().optional(),
});

export const featureQuerySchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'review', 'done', 'failed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  search: z.string().optional(),
  isArchived: z.string().optional().default('false').transform(v => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const moveFeatureSchema = z.object({
  columnId: z.string().uuid(),
});

export const createTaskInFeatureSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  requiredDomain: z.string().optional(),
  requiredCapabilities: z.array(z.string()).default([]),
  estimatedMinutes: z.number().int().positive().optional(),
  dependsOn: z.array(z.string().uuid()).default([]),
  order: z.number().int().default(0),
});

export const importBoardSchema = z.object({
  version: z.number(),
  exportedAt: z.string().datetime(),
  board: z.object({
    name: z.string(),
    description: z.string().optional().default(''),
    columns: z.array(z.object({
      name: z.string(),
      order: z.number(),
      wipLimit: z.number().nullable().optional(),
      autoAdvance: z.boolean().optional().default(false),
      requiresClaim: z.boolean().optional().default(false),
      nextColumnName: z.string().nullable().optional(),
      isTerminal: z.boolean().optional().default(false),
    })),
    features: z.array(z.object({
      title: z.string(),
      description: z.string().optional().default(''),
      acceptanceCriteria: z.string().optional().default(''),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
      labels: z.array(z.string()).optional().default([]),
      columnName: z.string(),
      status: z.string().optional().default('not_started'),
      dependsOn: z.array(z.string()).optional().default([]),
      blocks: z.array(z.string()).optional().default([]),
      dueAt: z.string().nullable().optional(),
      tasks: z.array(z.object({
        title: z.string(),
        description: z.string().optional().default(''),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
        status: z.string().optional().default('pending'),
        requiredDomain: z.string().nullable().optional(),
        requiredCapabilities: z.array(z.string()).optional().default([]),
        result: z.string().nullable().optional(),
        artifacts: z.array(z.object({
          type: z.enum(['file', 'pr', 'commit', 'log', 'screenshot']),
          url: z.string(),
          description: z.string(),
        })).optional().default([]),
        createdBy: z.string().optional().default('human'),
        createdAt: z.string().optional(),
      })).optional().default([]),
    })).optional().default([]),
    comments: z.array(z.object({
      taskTitle: z.string(),
      parentTaskTitle: z.string().nullable().optional(),
      content: z.string(),
      authorType: z.enum(['human', 'agent']),
      authorId: z.string(),
    })).optional().default([]),
    templates: z.array(z.object({
      name: z.string(),
      titlePattern: z.string(),
      descriptionPattern: z.string().optional().default(''),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
      labels: z.array(z.string()).optional().default([]),
      requiredDomain: z.string().nullable().optional(),
      requiredCapabilities: z.array(z.string()).optional().default([]),
      isDefault: z.boolean().optional().default(false),
    })).optional().default([]),
    webhooks: z.array(z.object({
      name: z.string(),
      url: z.string(),
      events: z.array(z.string()).optional().default([]),
      headers: z.record(z.string()).optional().default({}),
      format: z.enum(['standard', 'slack', 'discord']).optional().default('standard'),
      enabled: z.boolean().optional().default(true),
    })).optional().default([]),
  }),
});

export const createBoardSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  defaultColumns: z.boolean().optional().default(true),
  teamId: z.string().uuid().nullable().optional(),
});

export const retryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).max(10).optional(),
  backoffBase: z.number().int().min(1).optional(),
  backoffMultiplier: z.number().min(1).optional(),
  maxBackoff: z.number().int().min(1).optional(),
  escalateToHuman: z.boolean().optional(),
  retryOnStatuses: z.array(z.string()).optional(),
});

export const anomalySettingsSchema = z.object({
  enabled: z.boolean().optional().default(true),
  scanIntervalMinutes: z.number().int().min(1).max(60).optional().default(5),
  thresholds: z.object({
    staleInProgressMinutes: z.number().int().min(10).optional().default(240),
    rejectionRatePercent: z.number().min(1).max(100).optional().default(40),
    rejectionWindowTasks: z.number().int().min(3).max(100).optional().default(10),
    cycleTimeIncreasePercent: z.number().min(10).max(500).optional().default(50),
    backlogToAgentRatio: z.number().min(1).max(20).optional().default(2),
    agentOfflineMinutes: z.number().int().min(1).max(120).optional().default(15),
  }).optional(),
  notifications: z.object({
    email: z.boolean().optional().default(true),
    sse: z.boolean().optional().default(true),
    chat: z.boolean().optional().default(true),
  }).optional(),
});

export const autoAssignSettingsSchema = z.object({
  enabled: z.boolean().optional().default(false),
  strategy: z.enum(['round_robin', 'least_loaded', 'best_match']).optional().default('best_match'),
  maxTasksPerAgent: z.number().int().min(1).max(50).optional().default(5),
  requireDomainMatch: z.boolean().optional().default(false),
  requireCapabilityMatch: z.boolean().optional().default(false),
  excludeOfflineAgents: z.boolean().optional().default(true),
});

export const updateBoardSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  retrySettings: retryPolicySchema.nullable().optional(),
  anomalySettings: anomalySettingsSchema.nullable().optional(),
  autoAssignSettings: autoAssignSettingsSchema.nullable().optional(),
  eventRetentionDays: z.number().int().min(1).max(3650).optional(),
});

export const createColumnSchema = z.object({
  name: z.string().min(1).max(50),
  order: z.number().int().min(0).optional(),
  wipLimit: z.number().int().min(1).nullable().optional(),
  autoAdvance: z.boolean().optional(),
  requiresClaim: z.boolean().optional(),
  nextColumnId: z.string().uuid().nullable().optional(),
  isTerminal: z.boolean().optional(),
});

export const updateColumnSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  order: z.number().int().min(0).optional(),
  wipLimit: z.number().int().min(1).nullable().optional(),
  autoAdvance: z.boolean().optional(),
  requiresClaim: z.boolean().optional(),
  nextColumnId: z.string().uuid().nullable().optional(),
  isTerminal: z.boolean().optional(),
});

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  estimatedMinutes: z.number().int().min(1).nullable().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  status: z.enum(['pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed']).optional(),
  result: z.string().nullable().optional(),
  artifacts: z.array(z.object({
    type: z.enum(['file', 'pr', 'commit', 'log', 'screenshot']),
    url: z.string(),
    description: z.string(),
    createdAt: z.string().optional(),
  })).optional(),
  rejectedCount: z.number().int().min(0).optional(),
  rejectionReason: z.string().nullable().optional(),
  version: z.number().int().optional(),
  estimatedMinutes: z.number().int().min(1).nullable().optional(),
  retryPolicy: retryPolicySchema.nullable().optional(),
});

export const claimTaskSchema = z.object({
  agentId: z.string().uuid().optional(),
});

export const approveTaskSchema = z.object({
  reviewerId: z.string().min(1),
});

export const rejectTaskSchema = z.object({
  reviewerId: z.string().min(1),
  reason: z.string().min(1).max(1000),
});

export const releaseTaskSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const failTaskSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const submitTaskSchema = z.object({
  result: z.string().min(1).max(10000),
  artifacts: z.array(z.object({
    type: z.enum(['file', 'pr', 'commit', 'log', 'screenshot']),
    url: z.string(),
    description: z.string(),
    createdAt: z.string().optional(),
  })).optional().default([]),
});

export const completeTaskSchema = z.object({
  reviewNote: z.string().min(1).max(10000).optional(),
  artifacts: z.array(z.object({
    type: z.enum(['file', 'pr', 'commit', 'log', 'screenshot']),
    url: z.string(),
    description: z.string(),
    createdAt: z.string().optional(),
  })).optional().default([]),
});

export const delegateTaskSchema = z.object({
  toAgentId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export const cloneTaskSchema = z.object({
  includeSubtasks: z.boolean().optional().default(false),
  includeComments: z.boolean().optional().default(false),
});

export const createAgentSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['claude-code', 'codex', 'opencode']),
  domain: z.string().min(1).max(50),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  type: z.enum(['claude-code', 'codex', 'opencode']).optional(),
  domain: z.string().min(1).max(50).optional(),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).optional(),
});

export const heartbeatSchema = z.object({
  taskId: z.string().uuid().optional(),
  progress: z.string().optional(),
});

export const taskQuerySchema = z.object({
  status: z.enum(['pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  search: z.string().optional(),
  assignedAgentId: z.string().uuid().nullable().optional(),
  isArchived: z.string().optional().default('false').transform(v => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(['default', 'smart']).optional(),
  agentDomain: z.string().optional(),
  agentCapabilities: z.string().optional(),
});

export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const eventActionValues = ['created', 'claimed', 'started', 'submitted', 'approved', 'rejected', 'completed', 'failed', 'moved', 'released', 'dependency_resolved', 'delegated', 'cloned', 'retry_scheduled', 'retry_executed', 'escalated'] as const;

export const boardEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  action: z.enum(eventActionValues).optional(),
  actorType: z.enum(['human', 'agent', 'system']).optional(),
  actorId: z.string().uuid().optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

export type CreateBoardInput = z.infer<typeof createBoardSchema>;
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;
export type CreateColumnInput = z.infer<typeof createColumnSchema>;
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskSchema>;
export type ApproveTaskInput = z.infer<typeof approveTaskSchema>;
export type RejectTaskInput = z.infer<typeof rejectTaskSchema>;
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>;
export type FailTaskInput = z.infer<typeof failTaskSchema>;
export type SubmitTaskInput = z.infer<typeof submitTaskSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type DelegateTaskInput = z.infer<typeof delegateTaskSchema>;
export type CloneTaskInput = z.infer<typeof cloneTaskSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
export type EventsQueryInput = z.infer<typeof eventsQuerySchema>;

export const dashboardQuerySchema = z.object({
  boardId: z.string().uuid().optional(),
  period: z.enum(['7d', '30d', '90d']).optional().default('30d'),
});

export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;

const batchTaskIdList = z.array(z.string().uuid()).min(1).max(100);

export const batchTaskSchema = z.discriminatedUnion('operation', [
  z.object({
    taskIds: batchTaskIdList,
    operation: z.literal('priority'),
    payload: z.object({ priority: z.enum(['low', 'medium', 'high', 'critical']) }),
  }),
  z.object({
    taskIds: batchTaskIdList,
    operation: z.literal('assign'),
    payload: z.object({ assignedAgentId: z.string().uuid() }),
  }),
  z.object({
    taskIds: batchTaskIdList,
    operation: z.literal('delete'),
    payload: z.object({}),
  }),
]);

export type BatchTaskInput = z.infer<typeof batchTaskSchema>;
export type CreateFeatureInput = z.infer<typeof createFeatureSchema>;
export type UpdateFeatureInput = z.infer<typeof updateFeatureSchema>;
export type FeatureQueryInput = z.infer<typeof featureQuerySchema>;
export type MoveFeatureInput = z.infer<typeof moveFeatureSchema>;
export type CreateTaskInFeatureInput = z.infer<typeof createTaskInFeatureSchema>;
