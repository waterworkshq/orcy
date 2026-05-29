import { useState, useCallback } from "react";
import { api } from "../api/index.js";
import { notify } from "../lib/toast.js";
import type { Habitat } from "../types/index.js";

interface UseHabitatSettingsSaverOptions {
  habitatId: string;
  onUpdate: (board: Habitat) => void;
}

export function useHabitatSettingsSaver({ habitatId, onUpdate }: UseHabitatSettingsSaverOptions) {
  const [saving, setSaving] = useState(false);

  const saveSettings = useCallback(
    async (
      data: {
        name?: string;
        description?: string;
        retrySettings?: import("../types/index.js").RetryPolicy | null;
        anomalySettings?: import("../types/index.js").AnomalySettings | null;
        autoAssignSettings?: import("../types/index.js").AutoAssignSettings | null;
        prioritizationSettings?: import("../types/index.js").PrioritizationSettings | null;
        gitWorktreeSettings?: import("../types/index.js").GitWorktreeSettings | null;
      },
      successMessage: string,
    ) => {
      setSaving(true);
      try {
        const result = await api.habitats.update(habitatId, data);
        onUpdate(result.board);
        notify.success(successMessage);
      } catch (err) {
        notify.error((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [habitatId, onUpdate],
  );

  return { saving, saveSettings };
}
