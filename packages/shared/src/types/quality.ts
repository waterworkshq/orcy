/** Reusable template definition that groups a category of {@link QualityChecklistItem} entries applied to tasks. */
export interface QualityChecklistTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  isRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A single checkable item belonging to a {@link QualityChecklistTemplate}. */
export interface QualityChecklistItem {
  id: string;
  templateId: string;
  title: string;
  description: string;
  required: boolean;
  orderIndex: number;
  createdAt: string;
}

/** A checklist instance derived from a {@link QualityChecklistTemplate} and attached to a specific task. */
export interface TaskQualityChecklist {
  id: string;
  taskId: string;
  templateId: string | null;
  status: string;
  completedAt: string | null;
  completedBy: string | null;
  notes: string;
  createdAt: string;
}

/** Per-item completion state of a {@link QualityChecklistItem} within a {@link TaskQualityChecklist}. */
export interface TaskQualityChecklistItem {
  id: string;
  checklistId: string;
  itemId: string;
  isCompleted: boolean;
  completedBy: string | null;
  completedAt: string | null;
  evidenceUrl: string | null;
  notes: string;
}

/** Aggregated progress and approval-readiness view of all {@link TaskQualityChecklist} instances for a task. */
export interface TaskQualityReport {
  taskId: string;
  overallStatus: string;
  canApprove: boolean;
  checklists: {
    id: string;
    templateId: string;
    templateName: string;
    category: string;
    required: boolean;
    status: string;
    progress: { total: number; completed: number };
    items: {
      id: string;
      title: string;
      required: boolean;
      isCompleted: boolean;
      completedBy: string | null;
      completedAt: string | null;
      evidenceUrl: string | null;
      notes: string;
    }[];
  }[];
  missingRequirements: {
    category: string;
    missingItems: string[];
  }[];
}

/** Outcome of validating that a task's upstream task dependencies are satisfied. */
export interface DependencyValidationResult {
  canComplete: boolean;
  reason?: string;
  blockedBy?: {
    taskId: string;
    title: string;
    status: string;
  }[];
  incompleteTasks?: {
    taskId: string;
    title: string;
    status: string;
  }[];
}

/** Composite approval-readiness state of a task, summarizing its {@link TaskQualityReport} and gating signals. */
export interface ApprovalStatus {
  canBeApproved: boolean;
  reasons: string[];
  requirements: {
    qualityChecklist: { status: string; completed: number; total: number };
    dependencies: { status: string };
    timeTracking: { status: string };
    effortLogging: { status: string };
  };
}
