import { z } from "zod";
import {
  AGENT_TYPES,
  releaseSettingsSchema,
  roadmapSettingsSchema,
  codeReviewSettingsSchema,
  ciCdSettingsSchema,
} from "@orcy/shared";

const artifactSchema = z.object({
  type: z.enum(["file", "pr", "commit", "log", "screenshot"]),
  url: z.string(),
  description: z.string(),
  createdAt: z.string().optional(),
});

const importArtifactSchema = z.object({
  type: z.enum(["file", "pr", "commit", "log", "screenshot"]),
  url: z.string(),
  description: z.string(),
});

export const exportQuerySchema = z.object({
  include: z.string().optional().default("columns,missions,comments,templates,webhooks"),
  format: z.enum(["full", "missions-only"]).optional().default("full"),
  status: z.string().optional(),
});

export const createMissionSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(""),
  acceptanceCriteria: z.string().max(10000).default(""),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  labels: z.array(z.string()).default([]),
  dependsOn: z.array(z.string().uuid()).default([]),
  blocks: z.array(z.string().uuid()).default([]),
  dueAt: z.string().datetime().optional(),
  slaMinutes: z.number().int().positive().optional(),
  columnId: z.string().uuid().optional(),
  releaseGateType: z.enum(["patch", "minor", "major"]).optional(),
  releaseGateVersion: z.string().optional(),
  releaseDeadlineType: z.enum(["patch", "minor", "major"]).optional(),
  releaseDeadlineVersion: z.string().optional(),
});

export const updateMissionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
  blocks: z.array(z.string().uuid()).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  slaMinutes: z.number().int().positive().nullable().optional(),
  version: z.number().int().optional(),
  releaseGateType: z.enum(["patch", "minor", "major"]).nullable().optional(),
  releaseGateVersion: z.string().nullable().optional(),
  releaseDeadlineType: z.enum(["patch", "minor", "major"]).nullable().optional(),
  releaseDeadlineVersion: z.string().nullable().optional(),
});

export const missionQuerySchema = z.object({
  status: z.enum(["not_started", "in_progress", "review", "done", "failed"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  isArchived: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const moveMissionSchema = z.object({
  columnId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
});

export const reorderColumnsSchema = z.object({
  expectedOrder: z.array(z.string().uuid()).min(1),
  desiredOrder: z.array(z.string().uuid()).min(1),
});

export const createTaskInMissionSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(""),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  requiredDomain: z.string().optional(),
  requiredCapabilities: z.array(z.string()).default([]),
  estimatedMinutes: z.number().int().positive().optional(),
  dependsOn: z.array(z.string().uuid()).default([]),
  order: z.number().int().default(0),
});

/**
 * T6 Phase 2 — body for `POST /missions/:missionId/task-publications`
 * (the dormant REST publication route exposing {@link publishTaskCreation}).
 *
 * Distinct from {@link createTaskInMissionSchema} (legacy, T11 swaps it):
 *   - carries `attemptKey` (the client-supplied retry identity; retained
 *     across an unchanged Publish so the adapter can idempotently resume);
 *   - has NO `order` field — the kernel allocates `max(order)+1` in
 *     `createTaskWithClient`; the route MUST NOT force one;
 *   - carries an explicit `assignment` intent (auto | targeted);
 *   - `targetedAssignmentDeadline` is REQUIRED when `assignment.kind ===
 *     "targeted"` (the adapter throws otherwise; the route surfaces the
 *     constraint as a 422 via `.superRefine` instead of leaking the
 *     throwable).
 *
 * DORMANT: the legacy `POST /missions/:missionId/tasks` +
 * {@link createTaskInMissionSchema} stay byte-unchanged until T11 swaps
 * them. The new route ships alongside them.
 */
export const taskPublicationAssignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({
    kind: z.literal("targeted"),
    agentId: z.string().min(1),
  }),
]);

export const taskPublicationSchema = z
  .object({
    /** Client-supplied attempt identity — retained across unchanged Publishes. */
    attemptKey: z.string().min(1),

    /** Work-definition fields (mirror the kernel's canonical proposal). */
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    requiredDomain: z.string().nullable().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    estimatedMinutes: z.number().int().positive().nullable().optional(),
    labels: z.array(z.string()).optional(),
    dependsOn: z.array(z.string().uuid()).optional(),

    /** Assignment intent — defaults to `{kind:"auto"}`. */
    assignment: taskPublicationAssignmentSchema.optional().default({ kind: "auto" }),

    /**
     * Targeted-assignment reservation deadline. REQUIRED when
     * `assignment.kind === "targeted"`; the adapter throws otherwise. ISO
     * timestamp (e.g. `new Date(Date.now() + 24*3600_000).toISOString()`).
     * The cross-field constraint is enforced by `.superRefine` below to
     * surface as a typed 422 instead of leaking the adapter's throw.
     */
    targetedAssignmentDeadline: z.string().datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.assignment.kind === "targeted" && value.targetedAssignmentDeadline === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetedAssignmentDeadline"],
        message:
          "targetedAssignmentDeadline is required when assignment.kind === 'targeted' " +
          "(the adapter reserves the seat until this ISO timestamp).",
      });
    }
  });

export type TaskPublicationInput = z.infer<typeof taskPublicationSchema>;

const importHabitatSchemaBody = z.object({
  version: z.number(),
  exportedAt: z.string().datetime(),
  habitat: z.object({
    name: z.string(),
    description: z.string().optional().default(""),
    columns: z.array(
      z.object({
        name: z.string(),
        order: z.number(),
        wipLimit: z.number().nullable().optional(),
        autoAdvance: z.boolean().optional().default(false),
        requiresClaim: z.boolean().optional().default(false),
        nextColumnName: z.string().nullable().optional(),
        isTerminal: z.boolean().optional().default(false),
      }),
    ),
    missions: z
      .array(
        z.object({
          title: z.string(),
          description: z.string().optional().default(""),
          acceptanceCriteria: z.string().optional().default(""),
          priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
          labels: z.array(z.string()).optional().default([]),
          columnName: z.string(),
          status: z.string().optional().default("not_started"),
          dependsOn: z.array(z.string()).optional().default([]),
          blocks: z.array(z.string()).optional().default([]),
          dueAt: z.string().nullable().optional(),
          tasks: z
            .array(
              z.object({
                title: z.string(),
                description: z.string().optional().default(""),
                priority: z
                  .enum(["low", "medium", "high", "critical"])
                  .optional()
                  .default("medium"),
                status: z.string().optional().default("pending"),
                requiredDomain: z.string().nullable().optional(),
                requiredCapabilities: z.array(z.string()).optional().default([]),
                result: z.string().nullable().optional(),
                artifacts: z.array(importArtifactSchema).optional().default([]),
                createdBy: z.string().optional().default("human"),
                createdAt: z.string().optional(),
              }),
            )
            .optional()
            .default([]),
        }),
      )
      .optional()
      .default([]),
    comments: z
      .array(
        z.object({
          taskTitle: z.string(),
          parentTaskTitle: z.string().nullable().optional(),
          content: z.string(),
          authorType: z.enum(["human", "agent"]),
          authorId: z.string(),
        }),
      )
      .optional()
      .default([]),
    templates: z
      .array(
        z.object({
          name: z.string(),
          titlePattern: z.string(),
          descriptionPattern: z.string().optional().default(""),
          priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
          labels: z.array(z.string()).optional().default([]),
          requiredDomain: z.string().nullable().optional(),
          requiredCapabilities: z.array(z.string()).optional().default([]),
          isDefault: z.boolean().optional().default(false),
        }),
      )
      .optional()
      .default([]),
    webhooks: z
      .array(
        z.object({
          name: z.string(),
          url: z.string(),
          events: z.array(z.string()).optional().default([]),
          headers: z.record(z.string()).optional().default({}),
          format: z.enum(["standard", "slack", "discord"]).optional().default("standard"),
          enabled: z.boolean().optional().default(true),
        }),
      )
      .optional()
      .default([]),
  }),
});

// Legacy v1 exports used `board` at the top level and `features` for the
// mission collection. Normalize before strict parsing so a direct v1 HTTP
// import isn't silently stripped (the UI dialog already does this; this closes
// the HTTP-boundary gap so non-UI callers importing old exports also work).
export const importHabitatSchema = z.preprocess((data) => {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (!d.habitat && d.board && typeof d.board === "object") {
      d.habitat = d.board;
    }
    const habitat = d.habitat;
    if (habitat && typeof habitat === "object" && !Array.isArray(habitat)) {
      const h = habitat as Record<string, unknown>;
      if (!h.missions && Array.isArray(h.features)) {
        h.missions = h.features;
      }
    }
  }
  return data;
}, importHabitatSchemaBody);

// ---------------------------------------------------------------------------
// T10A M4 — Strict manifest v3 schema (DORMANT alongside the legacy preprocess).
//
// The preflight pipeline (`services/importManifest/preflightImport.ts`)
// consumes this schema as a defensive layer AFTER the legacy adapter
// (`legacyAdapter.ts`) emits the v3 shape + BEFORE the M3 domain handlers
// run their deep per-domain validation. The schema's primary job is to
// reject gross malformations early (unknown versions, missing required
// fields, malformed envelope shape). The M3 handlers own the deep
// per-domain validation (column-name uniqueness, mission columnName
// resolvability, dependency graph acyclicity, etc.) — that validation is
// NOT duplicated here.
//
// The legacy `z.preprocess` above STAYS byte-identical + active until T11's
// cutover (the legacy `importHabitat` route consumes it). The strict v3
// schema sits ALONGSIDE it, used only by the new manifest path that is
// itself dormant behind `ORCY_CREATION_PUBLICATION_ENABLED`.
// ---------------------------------------------------------------------------

const importManifestDomainEnvelopeSchema = z
  .object({
    disposition: z.enum(["replace", "preserve", "reset"]),
    data: z.unknown(),
  })
  .strict();

export const importManifestSchema = z
  .object({
    version: z.literal(3),
    manifestId: z.string().min(1),
    generatedAt: z.string().min(1),
    mode: z.enum(["new", "replacement"]),
    identityPolicy: z.enum(["remap", "restore"]),
    lineage: z
      .object({
        sourceHabitatId: z.string().nullable(),
        sourceExportedAt: z.string().nullable(),
        sourceManifestId: z.string().nullable(),
      })
      .strict(),
    domains: z
      .object({
        habitatSettings: importManifestDomainEnvelopeSchema.optional(),
        columns: importManifestDomainEnvelopeSchema.optional(),
        missions: importManifestDomainEnvelopeSchema.optional(),
        tasks: importManifestDomainEnvelopeSchema.optional(),
        subtasks: importManifestDomainEnvelopeSchema.optional(),
        dependencies: importManifestDomainEnvelopeSchema.optional(),
        comments: importManifestDomainEnvelopeSchema.optional(),
        templates: importManifestDomainEnvelopeSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type ImportManifestInput = z.infer<typeof importManifestSchema>;

export const createHabitatSchema = z.object({
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
  thresholds: z
    .object({
      staleInProgressMinutes: z.number().int().min(10).optional().default(240),
      rejectionRatePercent: z.number().min(1).max(100).optional().default(40),
      rejectionWindowTasks: z.number().int().min(3).max(100).optional().default(10),
      cycleTimeIncreasePercent: z.number().min(10).max(500).optional().default(50),
      backlogToAgentRatio: z.number().min(1).max(20).optional().default(2),
      agentOfflineMinutes: z.number().int().min(1).max(120).optional().default(15),
    })
    .optional(),
  notifications: z
    .object({
      email: z.boolean().optional().default(true),
      sse: z.boolean().optional().default(true),
      chat: z.boolean().optional().default(true),
    })
    .optional(),
});

export const autoAssignSettingsSchema = z.object({
  enabled: z.boolean().optional().default(false),
  strategy: z.enum(["round_robin", "least_loaded", "best_match"]).optional().default("best_match"),
  maxTasksPerAgent: z.number().int().min(1).max(50).optional().default(5),
  requireDomainMatch: z.boolean().optional().default(false),
  requireCapabilityMatch: z.boolean().optional().default(false),
  excludeOfflineAgents: z.boolean().optional().default(true),
});

export const triageSettingsSchema = z.object({
  minClusterSize: z.number().int().min(2).max(20),
  clusterWindowDays: z.number().int().min(1).max(90),
  agentQualityThreshold: z.number().int().min(0).max(100),
  agentQualityMinSample: z.number().int().min(1).max(50),
});

export const updateHabitatSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  retrySettings: retryPolicySchema.nullable().optional(),
  anomalySettings: anomalySettingsSchema.nullable().optional(),
  autoAssignSettings: autoAssignSettingsSchema.nullable().optional(),
  triageSettings: triageSettingsSchema.nullable().optional(),
  releaseSettings: releaseSettingsSchema.nullable().optional(),
  roadmapSettings: roadmapSettingsSchema.nullable().optional(),
  codeReviewSettings: codeReviewSettingsSchema.nullable().optional(),
  ciCdSettings: ciCdSettingsSchema.nullable().optional(),
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
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  estimatedMinutes: z.number().int().min(1).nullable().optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    requiredDomain: z.string().nullable().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    result: z.string().nullable().optional(),
    artifacts: z.array(artifactSchema).optional(),
    version: z.number().int().optional(),
    estimatedMinutes: z.number().int().min(1).nullable().optional(),
    retryPolicy: retryPolicySchema.nullable().optional(),
  })
  .strict();

export const claimTaskSchema = z.object({
  agentId: z.string().uuid().optional(),
});

/**
 * T5 Phase 3 — body for `POST /tasks/:taskId/assignment-attempts`. The
 * targeted-assignment RETRY surface (assigns an EXISTING task, post
 * `created_unassigned`, to a SPECIFIED agent). Distinct from
 * {@link claimTaskSchema} which lets the caller claim for themselves — this
 * route targets an explicit identity.
 */
export const assignmentAttemptSchema = z.object({
  requestedAgentId: z.string().min(1),
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
  artifacts: z.array(artifactSchema).optional().default([]),
});

export const completeTaskSchema = z.object({
  reviewNote: z.string().min(1).max(10000).optional(),
  artifacts: z.array(artifactSchema).optional().default([]),
  skipQualityGates: z.boolean().optional().default(false),
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
  type: z.enum(AGENT_TYPES),
  domain: z.string().min(1).max(50),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  type: z.enum(AGENT_TYPES).optional(),
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
  status: z
    .enum([
      "pending",
      "claimed",
      "in_progress",
      "submitted",
      "approved",
      "rejected",
      "done",
      "failed",
    ])
    .optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  search: z.string().optional(),
  assignedAgentId: z.string().uuid().nullable().optional(),
  isArchived: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(["default", "smart"]).optional(),
  agentDomain: z.string().optional(),
  agentCapabilities: z.string().optional(),
});

export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const eventActionValues = [
  "created",
  "claimed",
  "started",
  "submitted",
  "approved",
  "rejected",
  "completed",
  "failed",
  "moved",
  "released",
  "dependency_resolved",
  "delegated",
  "effort_logged",
  "effort_corrected",
  "cloned",
  "retry_scheduled",
  "retry_executed",
  "escalated",
] as const;

export const habitatEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  action: z.enum(eventActionValues).optional(),
  actorType: z.enum(["human", "agent", "system"]).optional(),
  actorId: z.string().uuid().optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

export type CreateHabitatInput = z.infer<typeof createHabitatSchema>;
export type UpdateHabitatInput = z.infer<typeof updateHabitatSchema>;
export type CreateColumnInput = z.infer<typeof createColumnSchema>;
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskSchema>;
export type AssignmentAttemptInput = z.infer<typeof assignmentAttemptSchema>;
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
  habitatId: z.string().uuid().optional(),
  period: z.enum(["7d", "30d", "90d"]).optional().default("30d"),
});

export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;

const batchTaskIdList = z.array(z.string().uuid()).min(1).max(100);

export const batchTaskSchema = z.discriminatedUnion("operation", [
  z.object({
    taskIds: batchTaskIdList,
    operation: z.literal("priority"),
    payload: z.object({ priority: z.enum(["low", "medium", "high", "critical"]) }),
  }),
  z.object({
    taskIds: batchTaskIdList,
    operation: z.literal("assign"),
    payload: z.object({ assignedAgentId: z.string().uuid() }),
  }),
  z.object({
    taskIds: batchTaskIdList,
    operation: z.literal("delete"),
    payload: z.object({}),
  }),
]);

export const daemonRegisterSchema = z.object({
  name: z.string().min(1).max(100),
  hostname: z.string().min(1).max(255),
  maxConcurrent: z.number().int().min(1).max(64).default(4),
  daemonVersion: z.string().min(1).max(50),
  detectedClis: z
    .array(
      z.object({
        type: z.enum(AGENT_TYPES),
        version: z.string().optional(),
        path: z.string().min(1),
      }),
    )
    .min(1),
  habitatIds: z.array(z.string().uuid()).min(1),
});

export const daemonHeartbeatSchema = z.object({
  agentStatuses: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        status: z.enum(["idle", "working", "offline"]),
      }),
    )
    .optional(),
  sessionProgresses: z
    .array(
      z.object({
        sessionId: z.string().uuid(),
        lastProgress: z.string().max(10000).optional(),
      }),
    )
    .optional(),
});

export const daemonClaimNextSchema = z.object({
  agentId: z.string().uuid(),
  habitatId: z.string().uuid(),
});

export const daemonSessionUpdateSchema = z.object({
  status: z.enum(["starting", "running", "completed", "failed", "released", "lost"]).optional(),
  lastProgress: z.string().max(10000).optional(),
  pid: z.number().int().optional(),
  workdir: z.string().max(2000).optional(),
  cliSessionId: z.string().max(255).optional(),
});

export type DaemonRegisterInput = z.infer<typeof daemonRegisterSchema>;
export type DaemonHeartbeatInput = z.infer<typeof daemonHeartbeatSchema>;
export type DaemonClaimNextInput = z.infer<typeof daemonClaimNextSchema>;
export type DaemonSessionUpdateInput = z.infer<typeof daemonSessionUpdateSchema>;
export type BatchTaskInput = z.infer<typeof batchTaskSchema>;
export type CreateMissionInput = z.infer<typeof createMissionSchema>;
export type UpdateMissionInput = z.infer<typeof updateMissionSchema>;
export type MissionQueryInput = z.infer<typeof missionQuerySchema>;
export type MoveMissionInput = z.infer<typeof moveMissionSchema>;
export type ReorderColumnsInput = z.infer<typeof reorderColumnsSchema>;
export type CreateTaskInMissionInput = z.infer<typeof createTaskInMissionSchema>;
export type TaskPublicationAssignment = z.infer<typeof taskPublicationAssignmentSchema>;

/**
 * T7 Phase 2 — body for `POST /tasks/:sourceTaskId/clone-publications`
 * (the dormant REST clone publication route exposing {@link publishTaskCreation}
 * with `cloneSourceTaskId`).
 *
 * Mirrors {@link taskPublicationSchema} for the publication contract (attempt
 * key + work-definition + assignment intent + targeted deadline) but adds
 * the CLONE-SPECIFIC knobs the legacy schema could not express:
 *
 *   - `subtasks[]` — the user's EDITED subtask list (added/removed/reordered/
 *     title-edited from the RESET list returned by `GET .../clone-preparation`).
 *     The T6 schema did not include this — interactive creation produces no
 *     subtasks at the call site; clone MUST because the source Task has
 *     Subtasks the user can edit.
 *   - `selectedDependencies[]` — the user's EXPLICIT selections from the
 *     UNSELECTED suggestions returned by the GET preparation. The kernel
 *     revalidates the final dependency graph at publication time.
 *   - `targetMissionId` — the explicit target Mission (the source Mission
 *     is the default, but the user may choose another active Mission in the
 *     same Habitat). This is REQUIRED here (unlike the T6 schema which derives
 *     it from the path) because the path carries `:sourceTaskId`, not the
 *     target.
 *
 * Retired fields (NOT present on this schema, by design — T7 removes the
 * immediate-copy + comment-copy options from the clone path):
 *   - `includeSubtasks` — the legacy `cloneTask` toggled subtask copying;
 *     the new path copies subtasks by default (reset to incomplete +
 *     unassigned) and lets the user edit in the composer.
 *   - `includeComments` — comments are NOT copied. T7 explicitly retired
 *     comment-copy.
 *   - `order` — the kernel allocates `max(order)+1` in `createTaskWithClient`;
 *     the route MUST NOT force one. Mirrored from T6.
 *
 * DORMANT: no production caller until T11. The new route ships alongside the
 * legacy `POST /tasks/:id/clone` + `cloneTaskSchema`, which stay
 * byte-unchanged.
 */
export const clonePublicationSchema = z
  .object({
    /** Client-supplied attempt identity — retained across unchanged Publishes. */
    attemptKey: z.string().min(1),

    /**
     * Work-definition fields — the user's EDITED values from the clone
     * composer (NOT a re-copy of the source).
     */
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    requiredDomain: z.string().nullable().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    estimatedMinutes: z.number().int().positive().nullable().optional(),
    labels: z.array(z.string()).optional(),

    /**
     * EDITED subtasks — the user can add/remove/reorder/edit-titles from
     * the RESET list returned by `GET .../clone-preparation`. Re-allocated
     * by the kernel's publication transaction (fresh IDs + execution state).
     */
    subtasks: z
      .array(
        z.object({
          title: z.string().min(1).max(500),
          order: z.number().int().min(0).optional(),
          assigneeId: z.string().nullable().optional(),
        }),
      )
      .optional(),

    /**
     * User-selected dependencies — the EXPLICIT selections from the
     * UNSELECTED suggestions surfaced by the clone-preparation GET. Each
     * entry is a Task id the new Task depends on. The kernel revalidates
     * the final dependency graph at publication time.
     */
    selectedDependencies: z.array(z.string().uuid()).optional(),

    /**
     * Target Mission — client sends explicitly even though the source's
     * Mission is the default. The route validates target habitat access
     * AND the kernel enforces same-Habitat via `cross_habitat_mission`
     * (a target outside the source's Habitat is rejected).
     */
    targetMissionId: z.string().min(1),

    /** Assignment intent — defaults to `{kind:"auto"}`. */
    assignment: taskPublicationAssignmentSchema.optional().default({ kind: "auto" }),

    /**
     * Targeted-assignment reservation deadline. REQUIRED when
     * `assignment.kind === "targeted"`; the adapter throws otherwise.
     * The cross-field constraint is enforced by `.superRefine` to surface
     * as a typed 422 instead of leaking the adapter's throw.
     */
    targetedAssignmentDeadline: z.string().datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.assignment.kind === "targeted" && value.targetedAssignmentDeadline === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetedAssignmentDeadline"],
        message:
          "targetedAssignmentDeadline is required when assignment.kind === 'targeted' " +
          "(the adapter reserves the seat until this ISO timestamp).",
      });
    }
  });

export type ClonePublicationInput = z.infer<typeof clonePublicationSchema>;
