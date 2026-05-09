import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { NumberField } from '../../ui/NumberField.js';
import { useHabitatSettingsSaver } from '../../../hooks/useHabitatSettingsSaver.js';
import type { Board, RetryPolicy } from '../../../types/index.js';

interface RetryPolicyTabProps {
  boardId: string;
  boardRetrySettings: RetryPolicy | null;
  onUpdate: (board: Board) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface RetryPolicyTabHandle {
  save: () => Promise<void>;
}

export const RetryPolicyTab = forwardRef<RetryPolicyTabHandle, RetryPolicyTabProps>(function RetryPolicyTab({
  boardId,
  boardRetrySettings,
  onUpdate,
  onSavingChange,
}, ref) {
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [retryMaxRetries, setRetryMaxRetries] = useState('3');
  const [retryBackoffBase, setRetryBackoffBase] = useState('60');
  const [retryBackoffMultiplier, setRetryBackoffMultiplier] = useState('2');
  const [retryMaxBackoff, setRetryMaxBackoff] = useState('3600');
  const [retryEscalateToHuman, setRetryEscalateToHuman] = useState(true);

  const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId: boardId, onUpdate });

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  useEffect(() => {
    if (boardRetrySettings) {
      setRetryEnabled(true);
      setRetryMaxRetries(boardRetrySettings.maxRetries?.toString() ?? '3');
      setRetryBackoffBase(boardRetrySettings.backoffBase?.toString() ?? '60');
      setRetryBackoffMultiplier(boardRetrySettings.backoffMultiplier?.toString() ?? '2');
      setRetryMaxBackoff(boardRetrySettings.maxBackoff?.toString() ?? '3600');
      setRetryEscalateToHuman(boardRetrySettings.escalateToHuman !== false);
    } else {
      setRetryEnabled(false);
    }
  }, [boardRetrySettings]);

  const handleSave = useCallback(async () => {
    await saveSettings({
      retrySettings: retryEnabled ? {
        maxRetries: parseInt(retryMaxRetries, 10),
        backoffBase: parseInt(retryBackoffBase, 10),
        backoffMultiplier: parseFloat(retryBackoffMultiplier),
        maxBackoff: parseInt(retryMaxBackoff, 10),
        escalateToHuman: retryEscalateToHuman,
      } : null,
    }, 'Retry policy saved');
  }, [saveSettings, retryEnabled, retryMaxRetries, retryBackoffBase, retryBackoffMultiplier, retryMaxBackoff, retryEscalateToHuman]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Enable Retry Policy</p>
          <p className="text-xs text-muted-foreground">Auto-retry rejected tasks with exponential backoff</p>
        </div>
        <ToggleSwitch
          checked={retryEnabled}
          onChange={(val) => setRetryEnabled(val)}
        />
      </div>
      {retryEnabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Max Retries"
              value={retryMaxRetries}
              onChange={(val) => setRetryMaxRetries(val)}
              min={0}
              max={10}
            />
            <NumberField
              label="Backoff Base (sec)"
              value={retryBackoffBase}
              onChange={(val) => setRetryBackoffBase(val)}
              min={1}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Backoff Multiplier"
              value={retryBackoffMultiplier}
              onChange={(val) => setRetryBackoffMultiplier(val)}
              min={1}
              step={0.5}
            />
            <NumberField
              label="Max Backoff (sec)"
              value={retryMaxBackoff}
              onChange={(val) => setRetryMaxBackoff(val)}
              min={1}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={retryEscalateToHuman}
              onChange={e => setRetryEscalateToHuman(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
            />
            <span className="text-sm">Escalate to human after max retries</span>
          </label>
        </div>
      )}
    </div>
  );
});
