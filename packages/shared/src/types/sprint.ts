/** Lifecycle states a {@link Sprint} moves through from initial planning to a terminal outcome. */
export type SprintStatus = 'planning' | 'active' | 'completed' | 'cancelled';

/** Strategy for handling missions still open when a {@link Sprint} ends. */
export type CarryOverPolicy = 'backlog' | 'next_sprint' | 'none';

/** A time-boxed iteration of committed missions within a habitat, tracked from planning to completion. */
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

/** Aggregate progress and velocity figures computed for a {@link Sprint}. */
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

/** Payload accepted when creating a new {@link Sprint}; fields with defaults are optional. */
export interface SprintCreateInput {
  name: string;
  goal?: string;
  startDate: string;
  endDate: string;
  capacityMinutes?: number | null;
  notes?: string;
}

/** Partial-update payload for an existing {@link Sprint}; only provided fields are changed. */
export interface SprintUpdateInput {
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  capacityMinutes?: number | null;
  notes?: string;
}
