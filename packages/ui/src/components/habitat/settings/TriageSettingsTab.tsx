import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { NumberField } from "../../ui/NumberField.js";
import { notify } from "../../../lib/toast.js";
import type { TriageSettings } from "../../../types/index.js";

interface TriageSettingsTabProps {
  habitatId: string;
  /** Initial settings; loaded from persisted storage by the parent if available. */
  triageSettings?: TriageSettings | null;
  onSavingChange?: (saving: boolean) => void;
}

export interface TriageSettingsTabHandle {
  save: () => Promise<void>;
}

const DEFAULTS: TriageSettings = {
  minClusterSize: 3,
  clusterWindowDays: 7,
  agentQualityThreshold: 40,
  agentQualityMinSample: 5,
};

function storageKey(habitatId: string): string {
  return `orcy:triage-settings:${habitatId}`;
}

function loadPersisted(habitatId: string): TriageSettings | null {
  try {
    const raw = localStorage.getItem(storageKey(habitatId));
    return raw ? (JSON.parse(raw) as TriageSettings) : null;
  } catch {
    return null;
  }
}

/**
 * Threshold configurability for the triage automation scans
 * (signal_pattern_clustered, agent_quality_degraded). Mirrors the
 * AnomalyDetectionTab pattern (forwardRef + imperative save handle).
 *
 * Backend storage wiring for `triageSettings` is not yet available on the
 * Habitat model; until it lands, settings persist to localStorage keyed by
 * habitat. See PROMPT-07 out-of-scope note.
 */
export const TriageSettingsTab = forwardRef<TriageSettingsTabHandle, TriageSettingsTabProps>(
  function TriageSettingsTab({ habitatId, triageSettings, onSavingChange }, ref) {
    const initial = triageSettings ?? loadPersisted(habitatId) ?? DEFAULTS;
    const [minClusterSize, setMinClusterSize] = useState(String(initial.minClusterSize));
    const [clusterWindowDays, setClusterWindowDays] = useState(String(initial.clusterWindowDays));
    const [agentQualityThreshold, setAgentQualityThreshold] = useState(
      String(initial.agentQualityThreshold),
    );
    const [agentQualityMinSample, setAgentQualityMinSample] = useState(
      String(initial.agentQualityMinSample),
    );
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      onSavingChange?.(saving);
    }, [saving, onSavingChange]);

    const handleSave = useCallback(async () => {
      setSaving(true);
      try {
        const next: TriageSettings = {
          minClusterSize: parseInt(minClusterSize, 10),
          clusterWindowDays: parseInt(clusterWindowDays, 10),
          agentQualityThreshold: parseInt(agentQualityThreshold, 10),
          agentQualityMinSample: parseInt(agentQualityMinSample, 10),
        };
        localStorage.setItem(storageKey(habitatId), JSON.stringify(next));
        notify.success("Triage settings saved");
      } catch (err) {
        notify.error((err as Error).message);
      } finally {
        setSaving(false);
      }
    }, [
      habitatId,
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
