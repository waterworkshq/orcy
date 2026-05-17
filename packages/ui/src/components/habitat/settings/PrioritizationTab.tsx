import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { useHabitatSettingsSaver } from '../../../hooks/useHabitatSettingsSaver.js';
import type { Habitat, PrioritizationSettings, PrioritizationRule } from '../../../types/index.js';

interface PrioritizationTabProps {
  habitatId: string;
  boardPrioritizationSettings: PrioritizationSettings | null;
  onUpdate: (board: Habitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface PrioritizationTabHandle {
  save: () => Promise<void>;
}

const RULE_TEMPLATE = `[
  {
    "id": "rule-1",
    "name": "Overdue tasks → critical",
    "enabled": true,
    "condition": { "type": "overdue", "byDays": 1 },
    "action": { "type": "set_priority", "value": "critical" },
    "priority": 1
  },
  {
    "id": "rule-2",
    "name": "SLA approaching → high",
    "enabled": true,
    "condition": { "type": "sla_approaching", "withinHours": 4 },
    "action": { "type": "set_priority", "value": "high" },
    "priority": 2
  },
  {
    "id": "rule-3",
    "name": "Due within 3 days → high",
    "enabled": true,
    "condition": { "type": "due_soon", "withinDays": 3 },
    "action": { "type": "set_priority", "value": "high" },
    "priority": 3
  },
  {
    "id": "rule-4",
    "name": "Pending >72h → bump",
    "enabled": true,
    "condition": { "type": "pending_duration", "greaterThanHours": 72 },
    "action": { "type": "bump_priority", "value": 1 },
    "priority": 4
  },
  {
    "id": "rule-5",
    "name": "Blocking 3+ tasks → bonus",
    "enabled": true,
    "condition": { "type": "dependency_count", "greaterThan": 3, "direction": "blocking" },
    "action": { "type": "set_score_bonus", "value": 15 },
    "priority": 5
  },
  {
    "id": "rule-6",
    "name": "Rejection spike → bonus",
    "enabled": true,
    "condition": { "type": "rejection_count", "greaterThan": 3 },
    "action": { "type": "set_score_bonus", "value": 10 },
    "priority": 6
  },
  {
    "id": "rule-7",
    "name": "Feature at risk → high",
    "enabled": true,
    "condition": { "type": "feature_status", "status": "at_risk" },
    "action": { "type": "set_priority", "value": "high" },
    "priority": 7
  },
  {
    "id": "rule-8",
    "name": "Agent idle 30min → label",
    "enabled": true,
    "condition": { "type": "agent_idle", "greaterThanMinutes": 30 },
    "action": { "type": "add_label", "value": "stale" },
    "priority": 8
  },
  {
    "id": "rule-9",
    "name": "Urgent label → bonus",
    "enabled": true,
    "condition": { "type": "label_match", "labels": ["urgent"] },
    "action": { "type": "set_score_bonus", "value": 20 },
    "priority": 9
  },
  {
    "id": "rule-10",
    "name": "Low priority check",
    "enabled": true,
    "condition": { "type": "priority_is", "priority": "low" },
    "action": { "type": "set_score_bonus", "value": -5 },
    "priority": 10
  },
  {
    "id": "rule-composite",
    "name": "Composite: overdue AND urgent label",
    "enabled": true,
    "condition": {
      "type": "and",
      "conditions": [
        { "type": "overdue" },
        { "type": "label_match", "labels": ["urgent"] }
      ]
    },
    "action": { "type": "set_priority", "value": "critical" },
    "priority": 0
  }
]`;

export const PrioritizationTab = forwardRef<PrioritizationTabHandle, PrioritizationTabProps>(function PrioritizationTab({
  habitatId,
  boardPrioritizationSettings,
  onUpdate,
  onSavingChange,
}, ref) {
  const [enabled, setEnabled] = useState(true);
  const [fallbackToManual, setFallbackToManual] = useState(true);
  const [evaluateInterval, setEvaluateInterval] = useState('5');
  const [rulesText, setRulesText] = useState('[]');
  const [validationError, setValidationError] = useState<string | null>(null);

  const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId: habitatId, onUpdate });

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  useEffect(() => {
    if (boardPrioritizationSettings) {
      setEnabled(boardPrioritizationSettings.enabled);
      setFallbackToManual(boardPrioritizationSettings.fallbackToManual);
      setEvaluateInterval(boardPrioritizationSettings.evaluateIntervalMinutes.toString());
      setRulesText(JSON.stringify(boardPrioritizationSettings.rules, null, 2));
    } else {
      setEnabled(false);
      setFallbackToManual(true);
      setEvaluateInterval('5');
      setRulesText('[]');
    }
    setValidationError(null);
  }, [boardPrioritizationSettings]);

  const handleSave = useCallback(async () => {
    setValidationError(null);

    let parsed: PrioritizationRule[];
    try {
      parsed = JSON.parse(rulesText);
      if (!Array.isArray(parsed)) {
        setValidationError('Rules must be a JSON array');
        return;
      }
    } catch (e) {
      setValidationError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }

    const settings: PrioritizationSettings = {
      enabled,
      evaluateIntervalMinutes: parseInt(evaluateInterval, 10) || 5,
      rules: parsed,
      fallbackToManual,
    };

    await saveSettings({
      prioritizationSettings: settings,
    }, 'Prioritization rules saved');
  }, [saveSettings, enabled, evaluateInterval, rulesText, fallbackToManual]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Enable Prioritization Engine</p>
          <p className="text-xs text-muted-foreground">Automatically adjust task priorities based on configurable rules</p>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={(val) => setEnabled(val)}
        />
      </div>

      {enabled && (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="prio-eval-interval" className="text-sm font-medium">Evaluate Interval (min)</label>
              <input
                id="prio-eval-interval"
                type="number"
                min={1}
                max={60}
                value={evaluateInterval}
                onChange={(e) => setEvaluateInterval(e.target.value)}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer pt-5">
              <input
                type="checkbox"
                checked={fallbackToManual}
                onChange={(e) => setFallbackToManual(e.target.checked)}
                className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <span className="text-sm">Fallback to manual priority</span>
            </label>
          </div>

          <div>
            <label htmlFor="prio-rules-editor" className="text-sm font-medium block mb-1">Rules (JSON)</label>
            <textarea
              id="prio-rules-editor"
              data-testid="prio-rules-editor"
              value={rulesText}
              onChange={(e) => {
                setRulesText(e.target.value);
                setValidationError(null);
              }}
              rows={12}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              spellCheck={false}
            />
          </div>

          {validationError && (
            <p data-testid="prio-validation-error" className="text-sm text-destructive">{validationError}</p>
          )}

          <details className="border border-border rounded-md">
            <summary className="px-3 py-2 text-sm font-medium cursor-pointer hover:bg-muted/50">
              Rule Template (all condition &amp; action types)
            </summary>
            <pre data-testid="prio-rule-template" className="px-3 py-2 text-xs font-mono overflow-auto max-h-64 bg-muted/30">
              {RULE_TEMPLATE}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
});
