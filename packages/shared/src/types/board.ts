import type { RetryPolicy } from "./task.js";
import type {
  AnomalySettings,
  AutoAssignSettings,
  AutomationSettings,
  CodeReviewSettings,
  CiCdSettings,
  GitWorktreeSettings,
  PrioritizationSettings,
  WikiSettings,
  TriageSettings,
  ReleaseSettings,
} from "./settings.js";
import type { TaskPriority } from "./task.js";
import type { MissionStatus } from "./feature.js";
import type { Artifact } from "./task.js";

/** A single kanban-style column belonging to a {@link Habitat}, with WIP controls and optional auto-advance/claim semantics. */
export interface Column {
  id: string;
  habitatId: string;
  name: string;
  order: number;
  wipLimit: number | null;
  autoAdvance: boolean;
  requiresClaim: boolean;
  nextColumnId: string | null;
  isTerminal: boolean;
}

/** A team-scoped board that owns ordered {@link Column}s and bundles per-board automation, retention, and review policies. */
export interface Habitat {
  id: string;
  name: string;
  description: string;
  columns?: Column[];
  teamId: string | null;
  retrySettings: RetryPolicy | null;
  anomalySettings: AnomalySettings | null;
  autoAssignSettings: AutoAssignSettings | null;
  codeReviewSettings: CodeReviewSettings | null;
  ciCdSettings: CiCdSettings | null;
  gitWorktreeSettings: GitWorktreeSettings | null;
  prioritizationSettings: PrioritizationSettings | null;
  automationSettings: AutomationSettings | null;
  wikiSettings: WikiSettings | null;
  triageSettings: TriageSettings | null;
  releaseSettings: ReleaseSettings | null;
  eventRetentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Rollup of cycle time, throughput, and per-column WIP health derived from activity across a {@link Habitat}. */
export interface HabitatStats {
  cycleTime: {
    averageMinutes: number;
    medianMinutes: number;
    count: number;
  };
  throughput: {
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
  wipHealth: {
    columnId: string;
    columnName: string;
    current: number;
    limit: number | null;
    health: "ok" | "warning" | "exceeded";
  }[];
}

/** Versioned, name-anchored snapshot of a {@link Habitat} (columns, features, comments, templates, webhooks) used for portable import/export. */
export interface HabitatExport {
  version: number;
  exportedAt: string;
  board: {
    name: string;
    description: string;
    columns: Array<{
      name: string;
      order: number;
      wipLimit: number | null;
      autoAdvance: boolean;
      requiresClaim: boolean;
      nextColumnName: string | null;
      isTerminal: boolean;
    }>;
    features: Array<{
      title: string;
      description: string;
      acceptanceCriteria: string;
      priority: TaskPriority;
      labels: string[];
      columnName: string;
      status: MissionStatus;
      dependsOn: string[];
      blocks: string[];
      dueAt: string | null;
      tasks: Array<{
        title: string;
        description: string;
        priority: TaskPriority;
        status: import("./task.js").TaskStatus;
        requiredDomain: string | null;
        requiredCapabilities: string[];
        result: string | null;
        artifacts: Artifact[];
        createdBy: string;
      }>;
    }>;
    comments: Array<{
      taskTitle: string;
      parentTaskTitle: string | null;
      content: string;
      authorType: "human" | "agent";
      authorId: string;
    }>;
    templates: Array<{
      name: string;
      titlePattern: string;
      descriptionPattern: string;
      priority: TaskPriority;
      labels: string[];
      requiredDomain: string | null;
      requiredCapabilities: string[];
      isDefault: boolean;
    }>;
    webhooks: Array<{
      name: string;
      url: string;
      events: string[];
      headers: Record<string, string>;
      format: "standard" | "slack" | "discord";
      enabled: boolean;
    }>;
  };
}
