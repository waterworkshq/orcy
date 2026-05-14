import React, { useState, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { GeneralTab, type GeneralTabHandle } from './settings/GeneralTab.js';
import { NotificationsTab, type NotificationsTabHandle } from './settings/NotificationsTab.js';
import { ChatIntegrationsTab } from './settings/ChatIntegrationsTab.js';
import { RetryPolicyTab, type RetryPolicyTabHandle } from './settings/RetryPolicyTab.js';
import { AnomalyDetectionTab, type AnomalyDetectionTabHandle } from './settings/AnomalyDetectionTab.js';
import { AutoAssignTab, type AutoAssignTabHandle } from './settings/AutoAssignTab.js';
import { PrioritizationTab, type PrioritizationTabHandle } from './settings/PrioritizationTab.js';
import { ScheduledTasksTab } from './settings/ScheduledTasksTab.js';
import { ExportBoardDialog } from './ExportHabitatDialog.js';
import { ImportBoardDialog } from './ImportHabitatDialog.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import type { Board } from '../../types/index.js';

type SettingsTab = 'general' | 'notifications' | 'chat' | 'retry' | 'anomaly' | 'auto_assign' | 'prioritization' | 'scheduled_tasks';

const TAB_CONFIG: Array<{ key: SettingsTab; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'chat', label: 'Chat Integrations' },
  { key: 'retry', label: 'Retry Policy' },
  { key: 'anomaly', label: 'Anomaly Detection' },
  { key: 'auto_assign', label: 'Auto-Assign' },
  { key: 'prioritization', label: 'Prioritization' },
  { key: 'scheduled_tasks', label: 'Scheduled Tasks' },
];

const SAVE_LABELS: Partial<Record<SettingsTab, string>> = {
  general: 'Save',
  notifications: 'Save Notifications',
  retry: 'Save Retry Policy',
  anomaly: 'Save Anomaly Settings',
  auto_assign: 'Save Auto-Assign Settings',
  prioritization: 'Save Prioritization Rules',
};

interface BoardSettingsDialogProps {
  board: Board;
  open: boolean;
  onClose: () => void;
  onUpdate: (board: Board) => void;
  onDelete: () => void;
}

export function BoardSettingsDialog({ board, open, onClose, onUpdate, onDelete }: BoardSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
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

  const handleTabSavingChange = useCallback((saving: boolean) => {
    setTabSaving(saving);
  }, []);

  function getActiveRef(): React.RefObject<{ save: () => Promise<void> } | null> {
    switch (activeTab) {
      case 'general': return generalRef;
      case 'notifications': return notificationsRef;
      case 'retry': return retryRef;
      case 'anomaly': return anomalyRef;
      case 'auto_assign': return autoAssignRef;
      case 'prioritization': return prioritizationRef;
      default: return { current: null };
    }
  }

  function handleTabSave() {
    const ref = getActiveRef();
    ref.current?.save();
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
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <DialogContent>
        {activeTab === 'general' && (
          <GeneralTab
            ref={generalRef}
            boardId={board.id}
            boardName={board.name}
            boardDescription={board.description}
            onUpdate={onUpdate}
            onClose={onClose}
            onSavingChange={handleTabSavingChange}
            onExportOpen={() => setExportOpen(true)}
            onImportOpen={() => setImportOpen(true)}
            onDeleteOpen={() => setDeleteOpen(true)}
          />
        )}
        {activeTab === 'notifications' && (
          <NotificationsTab
            ref={notificationsRef}
            boardId={board.id}
            onSavingChange={handleTabSavingChange}
          />
        )}
        {activeTab === 'chat' && (
          <ChatIntegrationsTab boardId={board.id} />
        )}
        {activeTab === 'retry' && (
          <RetryPolicyTab
            ref={retryRef}
            boardId={board.id}
            boardRetrySettings={board.retrySettings}
            onUpdate={onUpdate}
            onSavingChange={handleTabSavingChange}
          />
        )}
        {activeTab === 'anomaly' && (
          <AnomalyDetectionTab
            ref={anomalyRef}
            boardId={board.id}
            boardAnomalySettings={board.anomalySettings}
            onUpdate={onUpdate}
            onSavingChange={handleTabSavingChange}
          />
        )}
        {activeTab === 'auto_assign' && (
          <AutoAssignTab
            ref={autoAssignRef}
            boardId={board.id}
            boardAutoAssignSettings={board.autoAssignSettings}
            onUpdate={onUpdate}
            onSavingChange={handleTabSavingChange}
          />
        )}
        {activeTab === 'prioritization' && (
          <PrioritizationTab
            ref={prioritizationRef}
            boardId={board.id}
            boardPrioritizationSettings={board.prioritizationSettings}
            onUpdate={onUpdate}
            onSavingChange={handleTabSavingChange}
          />
        )}
        {activeTab === 'scheduled_tasks' && (
          <ScheduledTasksTab boardId={board.id} />
        )}
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
          await api.boards.delete(board.id);
          notify.success('Habitat deleted');
          onDelete();
          onClose();
        } catch (err) {
          notify.error((err as Error).message);
        }
      }}
      onCancel={() => setDeleteOpen(false)}
      title="Delete Habitat"
      description={`Are you sure you want to delete "${board.name}"? This will permanently remove all columns, tasks, and activity history. This cannot be undone.`}
      confirmLabel="Delete"
      variant="danger"
    />
    <ExportBoardDialog
      boardId={board.id}
      boardName={board.name}
      open={exportOpen}
      onClose={() => setExportOpen(false)}
    />
    <ImportBoardDialog
      boardId={board.id}
      boardName={board.name}
      open={importOpen}
      onClose={() => setImportOpen(false)}
      onImport={(importedBoardId) => {
        if (importedBoardId !== board.id) {
          notify.success('Habitat imported as new habitat');
        }
      }}
    />
    </>
  );
}
