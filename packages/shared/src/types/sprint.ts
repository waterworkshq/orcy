export type SprintStatus = 'planning' | 'active' | 'completed' | 'cancelled';

export type CarryOverPolicy = 'backlog' | 'next_sprint' | 'none';

export interface Sprint {
  id: string;
  habitatId: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  status: SprintStatus;
  committedMissionIds: string[];
  completedMissionIds: string[];
  capacityMinutes: number | null;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SprintMetrics {
  sprintId: string;
  totalMissions: number;
  completedMissions: number;
  completionPercentage: number;
  totalTasks: number;
  completedTasks: number;
  velocity: number;
  remainingDays: number;
  isOnTrack: boolean;
}

export interface SprintCreateInput {
  name: string;
  goal?: string;
  startDate: string;
  endDate: string;
  capacityMinutes?: number | null;
  notes?: string;
}

export interface SprintUpdateInput {
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  capacityMinutes?: number | null;
  notes?: string;
}
