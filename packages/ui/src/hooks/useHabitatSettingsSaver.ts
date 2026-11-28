import { useState, useCallback } from "react";
import { api } from "../api/index.js";
import { notify } from "../lib/toast.js";
import { useSessionLiveness } from "../lib/sessionState.js";
import type { PublicHabitat } from "../types/index.js";

interface UseHabitatSettingsSaverOptions {
  habitatId: string;
  onUpdate: (habitat: PublicHabitat) => void;
}

export function useHabitatSettingsSaver({ habitatId, onUpdate }: UseHabitatSettingsSaverOptions) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSessionActive = useSessionLiveness();

  const saveSettings = useCallback(
    async (
      data: {
        name?: string;
        description?: string;
        retrySettings?: import("../types/index.js").RetryPolicy | null;
        anomalySettings?: import("../api/domains/habitats.js").AnomalySettingsUpdate | null;
        autoAssignSettings?: import("../types/index.js").AutoAssignSettings | null;
        automationSettings?: import("../types/index.js").AutomationSettings | null;
        prioritizationSettings?: import("../types/index.js").PrioritizationSettings | null;
        gitWorktreeSettings?: import("../types/index.js").GitWorktreeSettings | null;
        triageSettings?: import("../types/index.js").TriageSettings | null;
        roadmapSettings?: import("../types/index.js").RoadmapSettings | null;
      },
      successMessage: string,
    ): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const result = await api.habitats.update(habitatId, data);
        if (!isSessionActive()) return false;
        onUpdate(result.habitat);
        notify.success(successMessage);
        return true;
      } catch (err) {
        if (!isSessionActive()) return false;
        const message =
          err instanceof Error && err.message ? err.message : "Failed to save settings";
        setError(message);
        notify.error(message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [habitatId, onUpdate, isSessionActive],
  );

  return { saving, error, saveSettings };
}
