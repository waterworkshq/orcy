import type { RetryPolicy } from './task.js';
import type { AnomalySettings, AutoAssignSettings, CodeReviewSettings, CiCdSettings, GitWorktreeSettings, PrioritizationSettings } from './settings.js';
import type { TaskPriority } from './task.js';
import type { FeatureStatus } from './feature.js';
import type { Artifact } from './task.js';

export interface Column {
  id: string;
  boardId: string;
  name: string;
  order: number;
  wipLimit: number | null;
  autoAdvance: boolean;
  requiresClaim: boolean;
  nextColumnId: string | null;
  isTerminal: boolean;
}

export interface Board {
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
  eventRetentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardStats {
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
    health: 'ok' | 'warning' | 'exceeded';
  }[];
}

export interface BoardExport {
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
      status: FeatureStatus;
      dependsOn: string[];
      blocks: string[];
      dueAt: string | null;
      tasks: Array<{
        title: string;
        description: string;
        priority: TaskPriority;
        status: import('./task.js').TaskStatus;
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
      authorType: 'human' | 'agent';
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
      format: 'standard' | 'slack' | 'discord';
      enabled: boolean;
    }>;
  };
}
