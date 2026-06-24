import React, { useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/index.js";
import { queryKeys } from "../../../lib/queryKeys.js";
import { notify } from "../../../lib/toast.js";
import { ToggleSwitch } from "../../ui/ToggleSwitch.js";
import type { Habitat, AutomationSettings } from "../../../types/index.js";

interface AutomationTabProps {
  habitatId: string;
  boardAutomationSettings?: AutomationSettings | null;
  onUpdate?: (board: Habitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface AutomationTabHandle {
  save: () => Promise<void>;
}

function jsonString(value: unknown, fallback = ""): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return fallback;
  }
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export const AutomationTab = forwardRef<AutomationTabHandle, AutomationTabProps>(
  function AutomationTab({ habitatId, boardAutomationSettings, onUpdate, onSavingChange }, ref) {
    const qc = useQueryClient();

    const executeActions = boardAutomationSettings?.executeActions ?? true;

    const executionToggleMut = useMutation({
      mutationFn: async (enabled: boolean) => {
        const result = await api.habitats.update(habitatId, {
          automationSettings: { executeActions: enabled },
        });
        return result;
      },
      onSuccess: (result) => {
        onUpdate?.(result.board);
        notify.success(
          executeActions ? "Automation execution disabled" : "Automation execution enabled",
        );
      },
      onError: (err: Error) => notify.error(err.message),
    });
    const [editingId, setEditingId] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [enabled, setEnabled] = useState(false);
    const [priority, setPriority] = useState(0);
    const [triggerJson, setTriggerJson] = useState('{"type":"event","eventType":"task.rejected"}');
    const [conditionJson, setConditionJson] = useState('{"type":"always"}');
    const [actionsJson, setActionsJson] = useState("[]");
    const [cooldownSeconds, setCooldownSeconds] = useState(300);
    const [maxRunsPerHour, setMaxRunsPerHour] = useState(30);
    const [showSimulation, setShowSimulation] = useState<string | null>(null);
    const [simulationResult, setSimulationResult] = useState<unknown>(null);

    const { data: rules, isLoading } = useQuery({
      queryKey: queryKeys.automation.rules(habitatId),
      queryFn: () => api.automation.listRules(habitatId) as Promise<any[]>,
    });

    const createMut = useMutation({
      mutationFn: (body: unknown) => api.automation.createRule(habitatId, body),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: queryKeys.automation.rules(habitatId) });
        resetForm();
        notify.success("Rule created");
      },
      onError: (err: Error) => notify.error(err.message),
    });

    const updateMut = useMutation({
      mutationFn: ({ id, body }: { id: string; body: unknown }) =>
        api.automation.updateRule(id, body),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: queryKeys.automation.rules(habitatId) });
        resetForm();
        notify.success("Rule updated");
      },
      onError: (err: Error) => notify.error(err.message),
    });

    const deleteMut = useMutation({
      mutationFn: (id: string) => api.automation.deleteRule(id),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: queryKeys.automation.rules(habitatId) });
        notify.success("Rule deleted");
      },
      onError: (err: Error) => notify.error(err.message),
    });

    const toggleMut = useMutation({
      mutationFn: ({ id, enable }: { id: string; enable: boolean }) =>
        enable ? api.automation.enable(id) : api.automation.disable(id),
      onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.automation.rules(habitatId) }),
      onError: (err: Error) => notify.error(err.message),
    });

    function resetForm() {
      setEditingId(null);
      setName("");
      setEnabled(false);
      setPriority(0);
      setTriggerJson('{"type":"event","eventType":"task.rejected"}');
      setConditionJson('{"type":"always"}');
      setActionsJson("[]");
      setCooldownSeconds(300);
      setMaxRunsPerHour(30);
    }

    function startEdit(rule: any) {
      setEditingId(rule.id);
      setName(rule.name ?? "");
      setEnabled(!!rule.enabled);
      setPriority(rule.priority ?? 0);
      setTriggerJson(jsonString(rule.trigger));
      setConditionJson(jsonString(rule.condition));
      setActionsJson(jsonString(rule.actions));
      setCooldownSeconds(rule.cooldownSeconds ?? 300);
      setMaxRunsPerHour(rule.maxRunsPerHour ?? 30);
    }

    async function handleSimulate(ruleId: string) {
      try {
        const result = await api.automation.simulate(ruleId, {
          triggerEventId: null,
          targetType: undefined,
          targetId: undefined,
        });
        setSimulationResult(result);
        setShowSimulation(ruleId);
      } catch (err) {
        notify.error((err as Error).message);
      }
    }

    const handleSave = useCallback(async () => {
      onSavingChange?.(true);
      try {
        const body = {
          name,
          enabled,
          priority,
          trigger: jsonParse(triggerJson),
          condition: jsonParse(conditionJson),
          actions: jsonParse(actionsJson),
          cooldownSeconds,
          maxRunsPerHour,
        };
        if (editingId) {
          await updateMut.mutateAsync({ id: editingId, body });
        } else {
          await createMut.mutateAsync(body);
        }
      } finally {
        onSavingChange?.(false);
      }
    }, [
      name,
      enabled,
      priority,
      triggerJson,
      conditionJson,
      actionsJson,
      cooldownSeconds,
      maxRunsPerHour,
      editingId,
      onSavingChange,
      createMut,
      updateMut,
    ]);

    useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

    const saving = createMut.isPending || updateMut.isPending;

    return (
      <div className="space-y-4" data-testid="automation-tab">
        <div className="border border-border rounded-lg p-3 bg-surface-container-low">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-headline font-bold uppercase tracking-wide">
                Action Execution
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                When enabled, matched automation rules will execute their defined actions (notify,
                create signal, create task, etc.). When disabled, rules still match and record runs,
                but no actions fire.
              </p>
            </div>
            <ToggleSwitch
              checked={executeActions}
              onChange={(checked) => executionToggleMut.mutate(checked)}
              disabled={executionToggleMut.isPending}
              aria-label="Toggle automation action execution"
            />
          </div>
          {!executeActions && (
            <p className="text-xs text-warning mt-2" data-testid="automation-execution-warning">
              Action execution is disabled — rules will match but not fire actions.
            </p>
          )}
        </div>

        {isLoading ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p>
        ) : (
          <>
            <div className="border border-border rounded-lg p-3 space-y-3">
              <h3 className="text-sm font-headline font-bold uppercase tracking-wide">
                {editingId ? "Edit Rule" : "New Rule"}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="Rule name"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Priority</label>
                  <input
                    type="number"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <label className="text-xs">Enabled</label>
                <span className="text-xs text-muted-foreground ml-2">
                  Cooldown: {cooldownSeconds}s
                </span>
                <span className="text-xs text-muted-foreground ml-2">Max/hr: {maxRunsPerHour}</span>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Trigger (JSON)</label>
                <textarea
                  rows={3}
                  value={triggerJson}
                  onChange={(e) => setTriggerJson(e.target.value)}
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Condition (JSON)</label>
                <textarea
                  rows={3}
                  value={conditionJson}
                  onChange={(e) => setConditionJson(e.target.value)}
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Actions (JSON array)</label>
                <textarea
                  rows={4}
                  value={actionsJson}
                  onChange={(e) => setActionsJson(e.target.value)}
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder='[{"type":"notify","recipients":[{"type":"assignee"}],"template":"Task rejected"}]'
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 transition-opacity disabled:opacity-50"
                  data-testid="save-rule-btn"
                >
                  {saving ? "Saving..." : editingId ? "Update" : "Create"}
                </button>
                {editingId && (
                  <button
                    onClick={resetForm}
                    className="rounded border border-border px-3 py-1.5 text-xs hover:bg-surface-container-high transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {/* Rules list */}
            <div className="space-y-2">
              <h3 className="text-sm font-headline font-bold uppercase tracking-wide">Rules</h3>
              {!rules || rules.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No automation rules yet
                </p>
              ) : (
                <div className="space-y-2">
                  {(rules as any[]).map((rule: any) => (
                    <div key={rule.id} className="border border-border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${rule.enabled ? "bg-green-500" : "bg-gray-400"}`}
                          />
                          <span className="text-sm font-medium">{rule.name}</span>
                          <span className="text-xs text-muted-foreground">
                            P{rule.priority ?? 0}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleSimulate(rule.id)}
                            className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-surface-container-high transition-colors"
                            title="Simulate"
                          >
                            Sim
                          </button>
                          <button
                            onClick={() => toggleMut.mutate({ id: rule.id, enable: !rule.enabled })}
                            className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-surface-container-high transition-colors"
                          >
                            {rule.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={() => startEdit(rule)}
                            className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-surface-container-high transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => {
                              if (confirm("Delete this rule?")) deleteMut.mutate(rule.id);
                            }}
                            className="rounded border border-red-200 px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50 transition-colors"
                          >
                            Del
                          </button>
                        </div>
                      </div>

                      {showSimulation === rule.id && simulationResult != null && (
                        <div className="bg-surface-container-low rounded p-2 text-xs font-mono whitespace-pre-wrap max-h-40 overflow-y-auto border border-border">
                          {jsonString(simulationResult, "No result")}
                        </div>
                      )}

                      <div className="text-[10px] text-muted-foreground">
                        Trigger:{" "}
                        {typeof rule.trigger === "object" ? (rule.trigger as any).type : "?"}
                        {rule.cooldownSeconds ? ` | Cooldown: ${rule.cooldownSeconds}s` : ""}
                        {rule.maxRunsPerHour ? ` | Max/hr: ${rule.maxRunsPerHour}` : ""}
                        {rule.lastRunAt
                          ? ` | Last: ${new Date(rule.lastRunAt).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  },
);
