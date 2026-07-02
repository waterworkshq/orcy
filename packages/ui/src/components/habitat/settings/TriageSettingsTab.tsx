import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { NumberField } from "../../ui/NumberField.js";
import { useHabitatSettingsSaver } from "../../../hooks/useHabitatSettingsSaver.js";
import { DEFAULT_TRIAGE_SETTINGS } from "@orcy/shared";
import type { Habitat, TriageSettings } from "../../../types/index.js";

interface TriageSettingsTabProps {
  habitatId: string;
  boardTriageSettings: TriageSettings | null;
  onUpdate: (board: Habitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface TriageSettingsTabHandle {
  save: () => Promise<void>;
}

const DEFAULTS: TriageSettings = DEFAULT_TRIAGE_SETTINGS;

/**
 * Threshold configurability for the triage automation scans
 * (signal_pattern_clustered, agent_quality_degraded). Mirrors the
 * AnomalyDetectionTab pattern (forwardRef + imperative save handle).
 * Settings persist to the backend via PATCH /habitats/:habitatId.
 */
export const TriageSettingsTab = forwardRef<TriageSettingsTabHandle, TriageSettingsTabProps>(
  function TriageSettingsTab({ habitatId, boardTriageSettings, onUpdate, onSavingChange }, ref) {
    const initial = boardTriageSettings ?? DEFAULTS;
    const [minClusterSize, setMinClusterSize] = useState(String(initial.minClusterSize));
    const [clusterWindowDays, setClusterWindowDays] = useState(String(initial.clusterWindowDays));
    const [agentQualityThreshold, setAgentQualityThreshold] = useState(
      String(initial.agentQualityThreshold),
    );
    const [agentQualityMinSample, setAgentQualityMinSample] = useState(
      String(initial.agentQualityMinSample),
    );

    const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId, onUpdate });

    useEffect(() => {
      const s = boardTriageSettings ?? DEFAULTS;
      setMinClusterSize(String(s.minClusterSize));
      setClusterWindowDays(String(s.clusterWindowDays));
      setAgentQualityThreshold(String(s.agentQualityThreshold));
      setAgentQualityMinSample(String(s.agentQualityMinSample));
    }, [boardTriageSettings]);

    useEffect(() => {
      onSavingChange?.(saving);
    }, [saving, onSavingChange]);

    const handleSave = useCallback(async () => {
      await saveSettings(
        {
          triageSettings: {
            minClusterSize: parseInt(minClusterSize, 10),
            clusterWindowDays: parseInt(clusterWindowDays, 10),
            agentQualityThreshold: parseInt(agentQualityThreshold, 10),
            agentQualityMinSample: parseInt(agentQualityMinSample, 10),
          },
        },
        "Triage settings saved",
      );
    }, [
      saveSettings,
      minClusterSize,
      clusterWindowDays,
      agentQualityThreshold,
      agentQualityMinSample,
    ]);

    useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

    return (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Thresholds for the triage automation scans. Clusters require a minimum signal count within
          the time window to surface; agent-quality findings require a minimum sample size and
          score.
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Min cluster size"
              value={minClusterSize}
              onChange={setMinClusterSize}
              min={2}
              max={20}
              id="triage-min-cluster"
              description="Minimum signals to form a cluster (2–20)"
            />
            <NumberField
              label="Cluster window (days)"
              value={clusterWindowDays}
              onChange={setClusterWindowDays}
              min={1}
              max={90}
              id="triage-window"
              description="Time window for clustering (1–90)"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Agent quality threshold"
              value={agentQualityThreshold}
              onChange={setAgentQualityThreshold}
              min={0}
              max={100}
              id="triage-quality-threshold"
              description="Score below which a finding fires (0–100)"
            />
            <NumberField
              label="Agent quality min sample"
              value={agentQualityMinSample}
              onChange={setAgentQualityMinSample}
              min={1}
              max={50}
              id="triage-quality-sample"
              description="Min sample size for the quality score (1–50)"
            />
          </div>
        </div>
      </div>
    );
  },
);
