import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { Button } from '../../ui/Button.js';
import { api } from '../../../api/index.js';
import { notify } from '../../../lib/toast.js';
import { useNotificationPrefs } from '../../../lib/useHabitatData.js';
import { queryKeys } from '../../../lib/queryKeys.js';
import type { NotificationPreferences } from '../../../types/index.js';

const PREF_LABELS: Array<{ key: keyof NotificationPreferences; label: string; description: string }> = [
  { key: 'taskAssigned', label: 'Task Assigned', description: 'When a task is assigned to you' },
  { key: 'taskSubmitted', label: 'Task Submitted', description: 'When a task is submitted for review' },
  { key: 'taskApproved', label: 'Task Approved', description: 'When your task is approved' },
  { key: 'taskRejected', label: 'Task Rejected', description: 'When your task is rejected' },
  { key: 'taskOverdue', label: 'Task Overdue', description: 'When a task passes its deadline' },
  { key: 'taskMentioned', label: 'Mentioned', description: 'When you are @mentioned in a comment' },
  { key: 'taskWatching', label: 'Watched Tasks', description: 'When a watched task is updated' },
];

interface NotificationsTabProps {
  habitatId: string;
  onSavingChange?: (saving: boolean) => void;
}

export interface NotificationsTabHandle {
  save: () => Promise<void>;
}

export const NotificationsTab = forwardRef<NotificationsTabHandle, NotificationsTabProps>(function NotificationsTab({
  habitatId,
  onSavingChange,
}, ref) {
  const { data: prefsData, isLoading: prefsLoading } = useNotificationPrefs(habitatId);
  const qc = useQueryClient();

  const [email, setEmail] = useState('');
  const [globalPrefs, setGlobalPrefs] = useState<NotificationPreferences | null>(null);
  const [boardPrefs, setBoardPrefs] = useState<NotificationPreferences | null>(null);
  const [useBoardPrefs, setUseBoardPrefs] = useState(false);
  const [prefsSaving, setPrefsSaving] = useState(false);

  const activePrefs = useBoardPrefs ? boardPrefs : globalPrefs;

  useEffect(() => {
    onSavingChange?.(prefsSaving);
  }, [prefsSaving, onSavingChange]);

  useEffect(() => {
    if (prefsData) {
      setEmail(prefsData.global.email ?? '');
      setGlobalPrefs(prefsData.global.preferences);
      setBoardPrefs(prefsData.board.preferences);
    }
  }, [prefsData]);

  function handlePrefToggle(key: keyof NotificationPreferences) {
    if (!activePrefs) return;
    const newPrefs = { ...activePrefs, [key]: !activePrefs[key] };
    if (useBoardPrefs) {
      setBoardPrefs(newPrefs);
    } else {
      setGlobalPrefs(newPrefs);
    }
  }

  const handleSave = useCallback(async () => {
    setPrefsSaving(true);
    try {
      if (email !== undefined) {
        await api.notifications.updateEmail(email || null);
      }
      if (useBoardPrefs && boardPrefs) {
        const result = await api.notifications.updateBoardPrefs(habitatId, boardPrefs);
        setBoardPrefs(result.preferences);
      } else if (globalPrefs) {
        const result = await api.notifications.updateGlobalPrefs(globalPrefs);
        setGlobalPrefs(result.preferences);
      }
      notify.success('Notification settings saved');
      qc.invalidateQueries({ queryKey: queryKeys.notificationPrefs.board(habitatId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setPrefsSaving(false);
    }
  }, [email, useBoardPrefs, boardPrefs, habitatId, globalPrefs, qc]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Email Address</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <p className="mt-1 text-xs text-muted-foreground">Required for receiving email notifications</p>
      </div>

      <div className="flex items-center justify-between border-b border-border pb-3">
        <div>
          <p className="text-sm font-medium">Per-Habitat Settings</p>
          <p className="text-xs text-muted-foreground">Override global settings for this habitat</p>
        </div>
        <ToggleSwitch
          checked={useBoardPrefs}
          onChange={(val) => setUseBoardPrefs(val)}
        />
      </div>

      {prefsLoading ? (
        <div className="py-4 text-center text-sm text-muted-foreground">Loading...</div>
      ) : (
        <div className="space-y-3">
          {PREF_LABELS.map(({ key, label, description }) => (
            <label key={key} className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={!!(activePrefs?.[key])}
                onChange={() => handlePrefToggle(key)}
                className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
});

export { PREF_LABELS };
