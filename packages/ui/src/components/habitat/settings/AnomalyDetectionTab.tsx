import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { NumberField } from '../../ui/NumberField.js';
import { useHabitatSettingsSaver } from '../../../hooks/useHabitatSettingsSaver.js';
import type { PublicHabitat, AnomalySettings } from '../../../types/index.js';

interface AnomalyDetectionTabProps {
  habitatId: string;
  boardAnomalySettings: AnomalySettings | null;
  onUpdate: (habitat: PublicHabitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface AnomalyDetectionTabHandle {
  save: () => Promise<void>;
}

export const AnomalyDetectionTab = forwardRef<AnomalyDetectionTabHandle, AnomalyDetectionTabProps>(function AnomalyDetectionTab({
  habitatId,
  boardAnomalySettings,
  onUpdate,
  onSavingChange,
}, ref) {
  const [anomalyEnabled, setAnomalyEnabled] = useState(true);
  const [anomalyScanInterval, setAnomalyScanInterval] = useState('5');
  const [anomalyStaleMinutes, setAnomalyStaleMinutes] = useState('240');
  const [anomalyRejectionRate, setAnomalyRejectionRate] = useState('40');
  const [anomalyRejectionWindow, setAnomalyRejectionWindow] = useState('10');
  const [anomalyCycleTimeIncrease, setAnomalyCycleTimeIncrease] = useState('50');
  const [anomalyBacklogRatio, setAnomalyBacklogRatio] = useState('2');
  const [anomalyOfflineMinutes, setAnomalyOfflineMinutes] = useState('15');
  const [anomalyNotifyEmail, setAnomalyNotifyEmail] = useState(true);
  const [anomalyNotifySse, setAnomalyNotifySse] = useState(true);
  const [anomalyNotifyChat, setAnomalyNotifyChat] = useState(true);

  const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId: habitatId, onUpdate });

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  useEffect(() => {
    if (boardAnomalySettings) {
      setAnomalyEnabled(boardAnomalySettings.enabled);
      setAnomalyScanInterval(boardAnomalySettings.scanIntervalMinutes.toString());
      setAnomalyStaleMinutes(boardAnomalySettings.thresholds.staleInProgressMinutes.toString());
      setAnomalyRejectionRate(boardAnomalySettings.thresholds.rejectionRatePercent.toString());
      setAnomalyRejectionWindow(boardAnomalySettings.thresholds.rejectionWindowTasks.toString());
      setAnomalyCycleTimeIncrease(boardAnomalySettings.thresholds.cycleTimeIncreasePercent.toString());
      setAnomalyBacklogRatio(boardAnomalySettings.thresholds.backlogToAgentRatio.toString());
      setAnomalyOfflineMinutes(boardAnomalySettings.thresholds.agentOfflineMinutes.toString());
      setAnomalyNotifyEmail(boardAnomalySettings.notifications.email);
      setAnomalyNotifySse(boardAnomalySettings.notifications.sse);
      setAnomalyNotifyChat(boardAnomalySettings.notifications.chat);
    } else {
      setAnomalyEnabled(true);
    }
  }, [boardAnomalySettings]);

  const handleSave = useCallback(async () => {
    await saveSettings({
      anomalySettings: anomalyEnabled ? {
        enabled: true,
        scanIntervalMinutes: parseInt(anomalyScanInterval, 10),
        thresholds: {
          staleInProgressMinutes: parseInt(anomalyStaleMinutes, 10),
          rejectionRatePercent: parseInt(anomalyRejectionRate, 10),
          rejectionWindowTasks: parseInt(anomalyRejectionWindow, 10),
          cycleTimeIncreasePercent: parseInt(anomalyCycleTimeIncrease, 10),
          backlogToAgentRatio: parseFloat(anomalyBacklogRatio),
          agentOfflineMinutes: parseInt(anomalyOfflineMinutes, 10),
        },
        notifications: {
          email: anomalyNotifyEmail,
          sse: anomalyNotifySse,
          chat: anomalyNotifyChat,
        },
      } : null,
    }, 'Anomaly detection settings saved');
  }, [saveSettings, anomalyEnabled, anomalyScanInterval, anomalyStaleMinutes, anomalyRejectionRate, anomalyRejectionWindow, anomalyCycleTimeIncrease, anomalyBacklogRatio, anomalyOfflineMinutes, anomalyNotifyEmail, anomalyNotifySse, anomalyNotifyChat]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Enable Anomaly Detection</p>
          <p className="text-xs text-muted-foreground">Automatically detect unusual patterns and alert</p>
        </div>
        <ToggleSwitch
          checked={anomalyEnabled}
          onChange={(val) => setAnomalyEnabled(val)}
        />
      </div>
      {anomalyEnabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Scan Interval (min)"
              value={anomalyScanInterval}
              onChange={setAnomalyScanInterval}
              min={1}
              max={60}
              id="anomaly-scan-interval"
            />
            <NumberField
              label="Stale In-Progress (min)"
              value={anomalyStaleMinutes}
              onChange={setAnomalyStaleMinutes}
              min={10}
              id="anomaly-stale"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Rejection Rate (%)"
              value={anomalyRejectionRate}
              onChange={setAnomalyRejectionRate}
              min={1}
              max={100}
              id="anomaly-rej-rate"
            />
            <NumberField
              label="Rejection Window (tasks)"
              value={anomalyRejectionWindow}
              onChange={setAnomalyRejectionWindow}
              min={3}
              max={100}
              id="anomaly-rej-window"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Cycle Time Increase (%)"
              value={anomalyCycleTimeIncrease}
              onChange={setAnomalyCycleTimeIncrease}
              min={10}
              max={500}
              id="anomaly-cycle"
            />
            <NumberField
              label="Backlog-to-Agent Ratio"
              value={anomalyBacklogRatio}
              onChange={setAnomalyBacklogRatio}
              min={1}
              max={20}
              step={0.5}
              id="anomaly-backlog"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Agent Offline (min)"
              value={anomalyOfflineMinutes}
              onChange={setAnomalyOfflineMinutes}
              min={1}
              max={120}
              id="anomaly-offline"
            />
          </div>
          <div className="pt-2 border-t border-border">
            <p className="text-sm font-medium mb-2">Notification Channels</p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={anomalyNotifySse} onChange={e => setAnomalyNotifySse(e.target.checked)} className="h-4 w-4 rounded border-input text-primary focus:ring-primary" />
                <span className="text-sm">Real-time (SSE)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={anomalyNotifyEmail} onChange={e => setAnomalyNotifyEmail(e.target.checked)} className="h-4 w-4 rounded border-input text-primary focus:ring-primary" />
                <span className="text-sm">Email (high/critical only)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={anomalyNotifyChat} onChange={e => setAnomalyNotifyChat(e.target.checked)} className="h-4 w-4 rounded border-input text-primary focus:ring-primary" />
                <span className="text-sm">Chat (Slack/Discord)</span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
