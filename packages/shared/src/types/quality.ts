export interface QualityChecklistTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  isRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QualityChecklistItem {
  id: string;
  templateId: string;
  title: string;
  description: string;
  required: boolean;
  orderIndex: number;
  createdAt: string;
}

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

export interface ApprovalStatus {
  canBeApproved: boolean;
  reasons: string[];
  requirements: {
    qualityChecklist: { status: string; completed: number; total: number };
    dependencies: { status: string };
    timeTracking: { status: string };
  };
}
