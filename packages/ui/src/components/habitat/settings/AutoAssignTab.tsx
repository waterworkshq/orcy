import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { NumberField } from '../../ui/NumberField.js';
import { useHabitatSettingsSaver } from '../../../hooks/useHabitatSettingsSaver.js';
import type { Board, AutoAssignSettings } from '../../../types/index.js';

interface AutoAssignTabProps {
  boardId: string;
  boardAutoAssignSettings: AutoAssignSettings | null;
  onUpdate: (board: Board) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface AutoAssignTabHandle {
  save: () => Promise<void>;
}

export const AutoAssignTab = forwardRef<AutoAssignTabHandle, AutoAssignTabProps>(function AutoAssignTab({
  boardId,
  boardAutoAssignSettings,
  onUpdate,
  onSavingChange,
}, ref) {
  const [autoAssignEnabled, setAutoAssignEnabled] = useState(false);
  const [autoAssignStrategy, setAutoAssignStrategy] = useState<AutoAssignSettings['strategy']>('best_match');
  const [autoAssignMaxTasks, setAutoAssignMaxTasks] = useState('5');
  const [autoAssignRequireDomain, setAutoAssignRequireDomain] = useState(false);
  const [autoAssignRequireCapability, setAutoAssignRequireCapability] = useState(false);
  const [autoAssignExcludeOffline, setAutoAssignExcludeOffline] = useState(true);

  const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId: boardId, onUpdate });

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  useEffect(() => {
    if (boardAutoAssignSettings) {
      setAutoAssignEnabled(boardAutoAssignSettings.enabled);
      setAutoAssignStrategy(boardAutoAssignSettings.strategy);
      setAutoAssignMaxTasks(boardAutoAssignSettings.maxTasksPerAgent.toString());
      setAutoAssignRequireDomain(boardAutoAssignSettings.requireDomainMatch);
      setAutoAssignRequireCapability(boardAutoAssignSettings.requireCapabilityMatch);
      setAutoAssignExcludeOffline(boardAutoAssignSettings.excludeOfflineAgents);
    } else {
      setAutoAssignEnabled(false);
    }
  }, [boardAutoAssignSettings]);

  const handleSave = useCallback(async () => {
    await saveSettings({
      autoAssignSettings: autoAssignEnabled ? {
        enabled: true,
        strategy: autoAssignStrategy,
        maxTasksPerAgent: parseInt(autoAssignMaxTasks, 10),
        requireDomainMatch: autoAssignRequireDomain,
        requireCapabilityMatch: autoAssignRequireCapability,
        excludeOfflineAgents: autoAssignExcludeOffline,
      } : null,
    }, 'Auto-assign settings saved');
  }, [saveSettings, autoAssignEnabled, autoAssignStrategy, autoAssignMaxTasks, autoAssignRequireDomain, autoAssignRequireCapability, autoAssignExcludeOffline]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Enable Auto-Assign</p>
          <p className="text-xs text-muted-foreground">Automatically assign new tasks to the best available agent</p>
        </div>
        <ToggleSwitch
          checked={autoAssignEnabled}
          onChange={(val) => setAutoAssignEnabled(val)}
        />
      </div>
      {autoAssignEnabled && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="auto-assign-strategy">Strategy</label>
            <select
              id="auto-assign-strategy"
              value={autoAssignStrategy}
              onChange={e => setAutoAssignStrategy(e.target.value as AutoAssignSettings['strategy'])}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="best_match">Best Match (score-based)</option>
              <option value="round_robin">Round Robin</option>
              <option value="least_loaded">Least Loaded</option>
            </select>
          </div>
          <NumberField
            label="Max Tasks Per Agent"
            value={autoAssignMaxTasks}
            onChange={setAutoAssignMaxTasks}
            min={1}
            max={50}
            id="auto-assign-max-tasks"
          />
          <div className="space-y-2 pt-2 border-t border-border">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoAssignRequireDomain}
                onChange={e => setAutoAssignRequireDomain(e.target.checked)}
                className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <div>
                <span className="text-sm">Require Domain Match</span>
                <p className="text-xs text-muted-foreground">Only assign to agents matching the task domain</p>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoAssignRequireCapability}
                onChange={e => setAutoAssignRequireCapability(e.target.checked)}
                className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <div>
                <span className="text-sm">Require Capability Match</span>
                <p className="text-xs text-muted-foreground">Only assign if agent has all required capabilities</p>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoAssignExcludeOffline}
                onChange={e => setAutoAssignExcludeOffline(e.target.checked)}
                className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <div>
                <span className="text-sm">Exclude Offline Agents</span>
                <p className="text-xs text-muted-foreground">Skip agents without recent heartbeat</p>
              </div>
            </label>
          </div>
        </div>
      )}
    </div>
  );
});
