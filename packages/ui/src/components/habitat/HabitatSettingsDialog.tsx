import React, { useState, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { GeneralTab, type GeneralTabHandle } from "./settings/GeneralTab.js";
import { NotificationsTab, type NotificationsTabHandle } from "./settings/NotificationsTab.js";
import { ChatIntegrationsTab } from "./settings/ChatIntegrationsTab.js";
import { RetryPolicyTab, type RetryPolicyTabHandle } from "./settings/RetryPolicyTab.js";
import {
  AnomalyDetectionTab,
  type AnomalyDetectionTabHandle,
} from "./settings/AnomalyDetectionTab.js";
import { AutoAssignTab, type AutoAssignTabHandle } from "./settings/AutoAssignTab.js";
import { PrioritizationTab, type PrioritizationTabHandle } from "./settings/PrioritizationTab.js";
import { AutomationTab, type AutomationTabHandle } from "./settings/AutomationTab.js";
import { ScheduledTasksTab } from "./settings/ScheduledTasksTab.js";
import { ReviewRulesTab } from "./settings/ReviewRulesTab.js";
import { IntegrationsTab } from "./settings/IntegrationsTab.js";
import { WorktreeTab, type WorktreeTabHandle } from "./settings/WorktreeTab.js";
import { RepositoryTab, type RepositoryTabHandle } from "./settings/RepositoryTab.js";
import { PluginsTab } from "./settings/PluginsTab.js";
import { TriageSettingsTab, type TriageSettingsTabHandle } from "./settings/TriageSettingsTab.js";
import {
  RoadmapSettingsTab,
  type RoadmapSettingsTabHandle,
} from "./settings/RoadmapSettingsTab.js";
import { ExportHabitatDialog } from "./ExportHabitatDialog.js";
import { ImportHabitatDialog } from "./ImportHabitatDialog.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import type { PublicHabitat } from "../../types/index.js";

type SettingsTab =
  | "general"
  | "notifications"
  | "chat"
  | "retry"
  | "anomaly"
  | "auto_assign"
  | "prioritization"
  | "automation"
  | "scheduled_tasks"
  | "review_rules"
  | "integrations"
  | "worktree"
  | "repository"
  | "plugins"
  | "triage"
  | "roadmap";

const TAB_CONFIG: Array<{ key: SettingsTab; label: string }> = [
  { key: "general", label: "General" },
  { key: "notifications", label: "Notifications" },
  { key: "chat", label: "Chat Integrations" },
  { key: "retry", label: "Retry Policy" },
  { key: "anomaly", label: "Anomaly Detection" },
  { key: "auto_assign", label: "Auto-Assign" },
  { key: "prioritization", label: "Prioritization" },
  { key: "automation", label: "Automation" },
  { key: "scheduled_tasks", label: "Scheduled Tasks" },
  { key: "review_rules", label: "Review Rules" },
  { key: "integrations", label: "Integrations" },
  { key: "worktree", label: "Worktree" },
  { key: "repository", label: "Repository" },
  { key: "plugins", label: "Plugins" },
  { key: "triage", label: "Triage" },
  { key: "roadmap", label: "Roadmap" },
];

const SAVE_LABELS: Partial<Record<SettingsTab, string>> = {
  general: "Save",
  notifications: "Save Notifications",
  retry: "Save Retry Policy",
  anomaly: "Save Anomaly Settings",
  auto_assign: "Save Auto-Assign Settings",
  prioritization: "Save Prioritization Rules",
  worktree: "Save Worktree Settings",
  repository: "Save Repository",
  triage: "Save Triage Settings",
  roadmap: "Save Roadmap Settings",
};

interface HabitatSettingsDialogProps {
  habitat: PublicHabitat;
  open: boolean;
  onClose: () => void;
  onUpdate: (habitat: PublicHabitat) => void;
  onDelete: () => void;
}

export function HabitatSettingsDialog({
  habitat,
  open,
  onClose,
  onUpdate,
  onDelete,
}: HabitatSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tabSaving, setTabSaving] = useState(false);

  const generalRef = useRef<GeneralTabHandle>(null);
  const notificationsRef = useRef<NotificationsTabHandle>(null);
  const retryRef = useRef<RetryPolicyTabHandle>(null);
  const anomalyRef = useRef<AnomalyDetectionTabHandle>(null);
  const autoAssignRef = useRef<AutoAssignTabHandle>(null);
  const prioritizationRef = useRef<PrioritizationTabHandle>(null);
  const automationRef = useRef<AutomationTabHandle>(null);
  const worktreeRef = useRef<WorktreeTabHandle>(null);
  const repositoryRef = useRef<RepositoryTabHandle>(null);
  const triageRef = useRef<TriageSettingsTabHandle>(null);
  const roadmapRef = useRef<RoadmapSettingsTabHandle>(null);

  const handleTabSavingChange = useCallback((saving: boolean) => {
    setTabSaving(saving);
  }, []);

  function getActiveRef(): React.RefObject<{ save: () => Promise<void> } | null> {
    switch (activeTab) {
      case "general":
        return generalRef;
      case "notifications":
        return notificationsRef;
      case "retry":
        return retryRef;
      case "anomaly":
        return anomalyRef;
      case "auto_assign":
        return autoAssignRef;
      case "prioritization":
        return prioritizationRef;
      case "automation":
        return automationRef;
      case "worktree":
        return worktreeRef;
      case "repository":
        return repositoryRef;
      case "triage":
        return triageRef;
      case "roadmap":
        return roadmapRef;
      default:
        return { current: null };
    }
  }

  async function handleTabSave() {
    const ref = getActiveRef();
    setTabSaving(true);
    try {
      await ref.current?.save();
    } catch {
      // Individual tabs surface their own save errors.
    } finally {
      setTabSaving(false);
    }
  }

  const hasSaveButton = activeTab in SAVE_LABELS;

  return (
    <>
      <Dialog open={open} onClose={onClose}>
        <DialogHeader>
          <DialogTitle>Habitat Settings</DialogTitle>
        </DialogHeader>
        <div className="flex border-b border-border px-6">
          {TAB_CONFIG.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <DialogContent>
          <div className={activeTab !== "general" ? "hidden" : ""}>
            <GeneralTab
              ref={generalRef}
              habitatId={habitat.id}
              boardName={habitat.name}
              boardDescription={habitat.description}
              onUpdate={onUpdate}
              onClose={onClose}
              onSavingChange={handleTabSavingChange}
              onExportOpen={() => setExportOpen(true)}
              onImportOpen={() => setImportOpen(true)}
              onDeleteOpen={() => setDeleteOpen(true)}
            />
          </div>
          <div className={activeTab !== "notifications" ? "hidden" : ""}>
            <NotificationsTab
              ref={notificationsRef}
              habitatId={habitat.id}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "chat" ? "hidden" : ""}>
            <ChatIntegrationsTab habitatId={habitat.id} />
          </div>
          <div className={activeTab !== "retry" ? "hidden" : ""}>
            <RetryPolicyTab
              ref={retryRef}
              habitatId={habitat.id}
              boardRetrySettings={habitat.retrySettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "anomaly" ? "hidden" : ""}>
            <AnomalyDetectionTab
              ref={anomalyRef}
              habitatId={habitat.id}
              boardAnomalySettings={habitat.anomalySettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "auto_assign" ? "hidden" : ""}>
            <AutoAssignTab
              ref={autoAssignRef}
              habitatId={habitat.id}
              boardAutoAssignSettings={habitat.autoAssignSettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "prioritization" ? "hidden" : ""}>
            <PrioritizationTab
              ref={prioritizationRef}
              habitatId={habitat.id}
              boardPrioritizationSettings={habitat.prioritizationSettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "scheduled_tasks" ? "hidden" : ""}>
            <ScheduledTasksTab habitatId={habitat.id} />
          </div>
          <div className={activeTab !== "automation" ? "hidden" : ""}>
            <AutomationTab
              ref={automationRef}
              habitatId={habitat.id}
              boardAutomationSettings={habitat.automationSettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "review_rules" ? "hidden" : ""}>
            <ReviewRulesTab habitatId={habitat.id} />
          </div>
          <div className={activeTab !== "integrations" ? "hidden" : ""}>
            <IntegrationsTab habitatId={habitat.id} />
          </div>
          <div className={activeTab !== "worktree" ? "hidden" : ""}>
            <WorktreeTab
              ref={worktreeRef}
              habitatId={habitat.id}
              boardGitWorktreeSettings={habitat.gitWorktreeSettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "repository" ? "hidden" : ""}>
            <RepositoryTab
              ref={repositoryRef}
              habitatId={habitat.id}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "plugins" ? "hidden" : ""}>
            <PluginsTab habitatId={habitat.id} />
          </div>
          <div className={activeTab !== "triage" ? "hidden" : ""}>
            <TriageSettingsTab
              ref={triageRef}
              habitatId={habitat.id}
              boardTriageSettings={habitat.triageSettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
          <div className={activeTab !== "roadmap" ? "hidden" : ""}>
            <RoadmapSettingsTab
              ref={roadmapRef}
              habitatId={habitat.id}
              boardRoadmapSettings={habitat.roadmapSettings}
              onUpdate={onUpdate}
              onSavingChange={handleTabSavingChange}
            />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={tabSaving}>
            Cancel
          </Button>
          {hasSaveButton && (
            <Button onClick={handleTabSave} loading={tabSaving}>
              {SAVE_LABELS[activeTab]}
            </Button>
          )}
        </DialogFooter>
      </Dialog>
      <ConfirmDialog
        open={deleteOpen}
        onConfirm={async () => {
          setDeleteOpen(false);
          try {
            await api.habitats.delete(habitat.id);
            notify.success("Habitat deleted");
            onDelete();
            onClose();
          } catch (err) {
            notify.error((err as Error).message);
          }
        }}
        onCancel={() => setDeleteOpen(false)}
        title="Delete Habitat"
        description={`Are you sure you want to delete "${habitat.name}"? This will permanently remove all columns, tasks, and activity history. This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
      />
      <ExportHabitatDialog
        habitatId={habitat.id}
        boardName={habitat.name}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
      />
      <ImportHabitatDialog
        habitatId={habitat.id}
        boardName={habitat.name}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(importedHabitatId) => {
          if (importedHabitatId !== habitat.id) {
            notify.success("Habitat imported as new habitat");
          }
        }}
      />
    </>
  );
}
