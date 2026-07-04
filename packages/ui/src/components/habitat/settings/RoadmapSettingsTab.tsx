import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { useHabitatSettingsSaver } from "../../../hooks/useHabitatSettingsSaver.js";
import { DEFAULT_ROADMAP_SETTINGS } from "@orcy/shared";
import type { Habitat, RoadmapSettings, RoadmapScoringAlgorithm } from "../../../types/index.js";

interface RoadmapSettingsTabProps {
  habitatId: string;
  boardRoadmapSettings: RoadmapSettings | null;
  onUpdate: (board: Habitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface RoadmapSettingsTabHandle {
  save: () => Promise<void>;
}

const DEFAULTS: RoadmapSettings = DEFAULT_ROADMAP_SETTINGS;

const ALGORITHMS: Array<{ value: RoadmapScoringAlgorithm; label: string; description: string }> = [
  {
    value: "fanout",
    label: "Fan-out (default)",
    description: "Prioritise tasks that unblock the most downstream work.",
  },
  {
    value: "depth_from_root",
    label: "Depth-from-root (foundational)",
    description: "Prioritise foundational missions near the dependency-graph roots.",
  },
  {
    value: "release_proximity",
    label: "Release proximity",
    description: "Prioritise work whose release-gate just resolved (freshly unblocked).",
  },
];

/**
 * Selectable roadmap scoring algorithm (v0.25.4). Mirrors the TriageSettingsTab
 * pattern (forwardRef + imperative save handle). Persists via PATCH /habitats/:habitatId.
 */
export const RoadmapSettingsTab = forwardRef<RoadmapSettingsTabHandle, RoadmapSettingsTabProps>(
  function RoadmapSettingsTab({ habitatId, boardRoadmapSettings, onUpdate, onSavingChange }, ref) {
    const initial = boardRoadmapSettings ?? DEFAULTS;
    const [algorithm, setAlgorithm] = useState<RoadmapScoringAlgorithm>(initial.scoringAlgorithm);

    const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId, onUpdate });

    useEffect(() => {
      setAlgorithm((boardRoadmapSettings ?? DEFAULTS).scoringAlgorithm);
    }, [boardRoadmapSettings]);

    useEffect(() => {
      onSavingChange?.(saving);
    }, [saving, onSavingChange]);

    const handleSave = useCallback(async () => {
      await saveSettings(
        { roadmapSettings: { scoringAlgorithm: algorithm } },
        "Roadmap scoring saved",
      );
    }, [saveSettings, algorithm]);

    useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

    const selected = ALGORITHMS.find((a) => a.value === algorithm);

    return (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Choose how the roadmap-position bonus ranks available tasks. This layers on top of
          priority, SLA, and capability scoring; it only changes which roadmap-position signal is
          used.
        </p>
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="roadmap-scoring-algorithm">
            Scoring algorithm
          </label>
          <select
            id="roadmap-scoring-algorithm"
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value as RoadmapScoringAlgorithm)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {ALGORITHMS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
        </div>
      </div>
    );
  },
);
