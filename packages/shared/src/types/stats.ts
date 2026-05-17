export interface TaskTimeRecord {
  id: string;
  taskId: string;
  agentId: string | null;
  minutesSpent: number;
  recordedAt: string;
  statusDuringWork: string;
}

export interface TaskTimeReport {
  taskId: string;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  cycleTimeMinutes: number | null;
  leadTimeMinutes: number | null;
  estimationAccuracy: number | null;
  heartbeatHistory: TaskTimeRecord[];
}

export interface DashboardStats {
  throughput: Array<{ date: string; count: number }>;
  cycleTime: Array<{ date: string; avgMinutes: number; medianMinutes: number }>;
  rejectionRate: Array<{ date: string; rejections: number; total: number }>;
  agentLeaderboard: Array<{
    agentId: string;
    agentName: string;
    completed: number;
    failed: number;
    avgCycleMinutes: number;
    approvalRate: number;
  }>;
  taskByPriority: { critical: number; high: number; medium: number; low: number };
  taskByStatus: { pending: number; claimed: number; in_progress: number; submitted: number; done: number };
  wipHealth: Array<{
    columnId: string;
    columnName: string;
    habitatId: string;
    habitatName: string;
    current: number;
    limit: number | null;
    health: 'ok' | 'warning' | 'exceeded';
  }>;
  webhookStats: { total: number; success: number; failed: number; pending: number; successRate: number };
  summary: {
    totalTasksCompleted: number;
    totalTasksInProgress: number;
    averageCycleTimeMinutes: number;
    overallRejectionRate: number;
    activeAgents: number;
  };
}

export interface HabitatMetrics {
  averageCycleTime: number;
  averageLeadTime: number;
  averageEstimationAccuracy: number;
  totalPlannedMinutes: number;
  totalActualMinutes: number;
  overdueTasks: number;
  onTimeCompletionRate: number;
  agentMetrics: {
    agentId: string;
    agentName: string;
    tasksCompleted: number;
    averageCycleTime: number;
    averageEstimationAccuracy: number;
    totalTimeTracked: number;
  }[];
}
