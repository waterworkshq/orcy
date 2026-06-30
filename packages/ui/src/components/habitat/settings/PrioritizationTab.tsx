import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  DndContext,
  type DragEndEvent,
  closestCorners,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, Plus, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { ToggleSwitch } from "../../ui/ToggleSwitch.js";
import { Button } from "../../ui/Button.js";
import { useHabitatSettingsSaver } from "../../../hooks/useHabitatSettingsSaver.js";
import type {
  Habitat,
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
} from "../../../types/index.js";

interface PrioritizationTabProps {
  habitatId: string;
  boardPrioritizationSettings: PrioritizationSettings | null;
  onUpdate: (board: Habitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface PrioritizationTabHandle {
  save: () => Promise<void>;
}

type FieldSpec =
  | { kind: "number"; key: string; label: string; min?: number; fallback?: number }
  | {
      kind: "text";
      key: string;
      label: string;
      placeholder?: string;
      toInput?: (v: unknown) => string;
      toState?: (v: string) => string | string[];
    }
  | {
      kind: "select";
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    };

interface TypeConfig<T> {
  label: string;
  fields: FieldSpec[];
  grid?: boolean;
  defaults: T;
  describe: (v: T) => string;
}

const CONDITIONS: Record<string, TypeConfig<PrioritizationRuleCondition>> = {
  overdue: {
    label: "Overdue",
    fields: [
      { kind: "number", key: "byDays", label: "By days (0 = any overdue)", min: 0, fallback: 0 },
    ],
    defaults: { type: "overdue", byDays: 0 } as PrioritizationRuleCondition,
    describe: (c) =>
      `overdue by ${(c as Extract<PrioritizationRuleCondition, { type: "overdue" }>).byDays ?? 0}d`,
  },
  sla_approaching: {
    label: "SLA Approaching",
    fields: [{ kind: "number", key: "withinHours", label: "Within hours", min: 1, fallback: 1 }],
    defaults: { type: "sla_approaching", withinHours: 4 } as PrioritizationRuleCondition,
    describe: (c) =>
      `SLA within ${(c as Extract<PrioritizationRuleCondition, { type: "sla_approaching" }>).withinHours}h`,
  },
  due_soon: {
    label: "Due Soon",
    fields: [{ kind: "number", key: "withinDays", label: "Within days", min: 1, fallback: 1 }],
    defaults: { type: "due_soon", withinDays: 3 } as PrioritizationRuleCondition,
    describe: (c) =>
      `due within ${(c as Extract<PrioritizationRuleCondition, { type: "due_soon" }>).withinDays}d`,
  },
  pending_duration: {
    label: "Pending Duration",
    fields: [
      {
        kind: "number",
        key: "greaterThanHours",
        label: "Greater than (hours)",
        min: 1,
        fallback: 1,
      },
    ],
    defaults: { type: "pending_duration", greaterThanHours: 72 } as PrioritizationRuleCondition,
    describe: (c) =>
      `pending >${(c as Extract<PrioritizationRuleCondition, { type: "pending_duration" }>).greaterThanHours}h`,
  },
  dependency_count: {
    label: "Dependency Count",
    grid: true,
    fields: [
      { kind: "number", key: "greaterThan", label: "Greater than", min: 0, fallback: 0 },
      {
        kind: "select",
        key: "direction",
        label: "Direction",
        options: [
          { value: "blocking", label: "Blocking" },
          { value: "blocked_by", label: "Blocked by" },
        ],
      },
    ],
    defaults: {
      type: "dependency_count",
      greaterThan: 3,
      direction: "blocking",
    } as PrioritizationRuleCondition,
    describe: (c) => {
      const narrowed = c as Extract<PrioritizationRuleCondition, { type: "dependency_count" }>;
      return `${narrowed.direction} ${narrowed.greaterThan}+ deps`;
    },
  },
  rejection_count: {
    label: "Rejection Count",
    fields: [{ kind: "number", key: "greaterThan", label: "Greater than", min: 0, fallback: 0 }],
    defaults: { type: "rejection_count", greaterThan: 3 } as PrioritizationRuleCondition,
    describe: (c) =>
      `rejected ${(c as Extract<PrioritizationRuleCondition, { type: "rejection_count" }>).greaterThan}+ times`,
  },
  mission_status: {
    label: "Mission Status",
    fields: [
      { kind: "text", key: "status", label: "Status", placeholder: "e.g. at_risk, in_progress" },
    ],
    defaults: { type: "mission_status", status: "at_risk" } as PrioritizationRuleCondition,
    describe: (c) =>
      `mission is ${(c as Extract<PrioritizationRuleCondition, { type: "mission_status" }>).status}`,
  },
  agent_idle: {
    label: "Agent Idle",
    fields: [
      {
        kind: "number",
        key: "greaterThanMinutes",
        label: "Greater than (minutes)",
        min: 1,
        fallback: 1,
      },
    ],
    defaults: { type: "agent_idle", greaterThanMinutes: 30 } as PrioritizationRuleCondition,
    describe: (c) =>
      `idle >${(c as Extract<PrioritizationRuleCondition, { type: "agent_idle" }>).greaterThanMinutes}min`,
  },
  label_match: {
    label: "Label Match",
    fields: [
      {
        kind: "text",
        key: "labels",
        label: "Labels (comma-separated)",
        placeholder: "e.g. urgent, security",
        toInput: (v: any) => (Array.isArray(v) ? v.join(", ") : ""),
        toState: (v: string) =>
          v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
      },
    ],
    defaults: { type: "label_match", labels: [] } as PrioritizationRuleCondition,
    describe: (c) =>
      `label [${(c as Extract<PrioritizationRuleCondition, { type: "label_match" }>).labels.join(", ")}]`,
  },
  priority_is: {
    label: "Priority Is",
    fields: [
      {
        kind: "select",
        key: "priority",
        label: "Priority",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "critical", label: "Critical" },
        ],
      },
    ],
    defaults: { type: "priority_is", priority: "low" } as PrioritizationRuleCondition,
    describe: (c) =>
      `priority is ${(c as Extract<PrioritizationRuleCondition, { type: "priority_is" }>).priority}`,
  },
};

const ACTIONS: Record<string, TypeConfig<PrioritizationRuleAction>> = {
  set_priority: {
    label: "Set Priority",
    fields: [
      {
        kind: "select",
        key: "value",
        label: "Priority",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "critical", label: "Critical" },
        ],
      },
    ],
    defaults: { type: "set_priority", value: "high" } as PrioritizationRuleAction,
    describe: (a) =>
      `set priority to ${(a as Extract<PrioritizationRuleAction, { type: "set_priority" }>).value}`,
  },
  bump_priority: {
    label: "Bump Priority",
    fields: [{ kind: "number", key: "value", label: "Bump by", min: -5, fallback: 1 }],
    defaults: { type: "bump_priority", value: 1 } as PrioritizationRuleAction,
    describe: (a) =>
      `bump priority by ${(a as Extract<PrioritizationRuleAction, { type: "bump_priority" }>).value}`,
  },
  add_label: {
    label: "Add Label",
    fields: [{ kind: "text", key: "value", label: "Label", placeholder: "e.g. stale" }],
    defaults: { type: "add_label", value: "" } as PrioritizationRuleAction,
    describe: (a) =>
      `add label "${(a as Extract<PrioritizationRuleAction, { type: "add_label" }>).value}"`,
  },
  set_score_bonus: {
    label: "Score Bonus",
    fields: [
      { kind: "number", key: "value", label: "Score bonus (negative to penalize)", fallback: 0 },
    ],
    defaults: { type: "set_score_bonus", value: 10 } as PrioritizationRuleAction,
    describe: (a) => {
      const v = (a as Extract<PrioritizationRuleAction, { type: "set_score_bonus" }>).value;
      return `score ${v > 0 ? "+" : ""}${v}`;
    },
  },
};

const CONDITION_OPTIONS = Object.entries(CONDITIONS).map(([value, cfg]) => ({
  value,
  label: cfg.label,
}));
const ACTION_OPTIONS = Object.entries(ACTIONS).map(([value, cfg]) => ({ value, label: cfg.label }));

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function generateId(): string {
  return `rule-${crypto.randomUUID()}`;
}

function getDefaultCondition(type: string): PrioritizationRuleCondition {
  return (CONDITIONS[type]?.defaults ?? CONDITIONS.overdue.defaults) as PrioritizationRuleCondition;
}

function getDefaultAction(type: string): PrioritizationRuleAction {
  return (ACTIONS[type]?.defaults ?? ACTIONS.set_priority.defaults) as PrioritizationRuleAction;
}

function describeCondition(c: PrioritizationRuleCondition): string {
  if (c.type === "and" || c.type === "or") return `composite (${c.type.toUpperCase()})`;
  return CONDITIONS[c.type]?.describe(c) ?? "unknown";
}

function describeAction(a: PrioritizationRuleAction): string {
  return ACTIONS[a.type]?.describe(a) ?? "unknown";
}

const INPUT_CLS =
  "w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary";
const LABEL_CLS = "mb-1 block text-xs text-muted-foreground";

function renderField<T extends Record<string, unknown>>(
  obj: T,
  field: FieldSpec,
  onChange: (updated: T) => void,
) {
  const raw = obj[field.key];

  if (field.kind === "number") {
    const value = (raw as number) ?? field.fallback ?? 0;
    return (
      <div key={field.key}>
        <label className={LABEL_CLS}>{field.label}</label>
        <input
          type="number"
          min={field.min}
          value={value}
          onChange={(e) =>
            onChange({
              ...obj,
              [field.key]: parseInt(e.target.value, 10) || (field.fallback ?? 0),
            } as T)
          }
          className={INPUT_CLS}
        />
      </div>
    );
  }

  if (field.kind === "text") {
    const value = field.toInput ? field.toInput(raw) : ((raw as string) ?? "");
    return (
      <div key={field.key}>
        <label className={LABEL_CLS}>{field.label}</label>
        <input
          type="text"
          value={value}
          onChange={(e) =>
            onChange({
              ...obj,
              [field.key]: field.toState ? field.toState(e.target.value) : e.target.value,
            } as T)
          }
          placeholder={field.placeholder}
          className={INPUT_CLS}
        />
      </div>
    );
  }

  return (
    <div key={field.key}>
      <label className={LABEL_CLS}>{field.label}</label>
      <select
        value={raw as string}
        onChange={(e) => onChange({ ...obj, [field.key]: e.target.value } as T)}
        className={INPUT_CLS}
      >
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ConditionEditor({
  condition,
  onChange,
}: {
  condition: PrioritizationRuleCondition;
  onChange: (c: PrioritizationRuleCondition) => void;
}) {
  const isLeaf = condition.type !== "and" && condition.type !== "or";

  if (!isLeaf) {
    return (
      <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 space-y-2">
        <div className="flex items-center gap-2 text-xs text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>Composite conditions can only be edited in Advanced Mode</span>
        </div>
        <div>
          <label className={LABEL_CLS}>Replace with leaf condition</label>
          <select
            value=""
            onChange={(e) => onChange(getDefaultCondition(e.target.value))}
            className={INPUT_CLS}
          >
            <option value="">Select type...</option>
            {CONDITION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  const cfg = CONDITIONS[condition.type];
  const fieldsCls = cfg?.grid ? "grid grid-cols-2 gap-2" : "space-y-2";

  return (
    <div className="space-y-2">
      <div>
        <label className={LABEL_CLS}>Condition</label>
        <select
          value={condition.type}
          onChange={(e) => onChange(getDefaultCondition(e.target.value))}
          className={INPUT_CLS}
        >
          {CONDITION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className={fieldsCls}>{cfg?.fields.map((f) => renderField(condition, f, onChange))}</div>
    </div>
  );
}

function ActionEditor({
  action,
  onChange,
}: {
  action: PrioritizationRuleAction;
  onChange: (a: PrioritizationRuleAction) => void;
}) {
  const cfg = ACTIONS[action.type];
  const fieldsCls = cfg?.grid ? "grid grid-cols-2 gap-2" : "space-y-2";

  return (
    <div className="space-y-2">
      <div>
        <label className={LABEL_CLS}>Action</label>
        <select
          value={action.type}
          onChange={(e) => onChange(getDefaultAction(e.target.value))}
          className={INPUT_CLS}
        >
          {ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className={fieldsCls}>{cfg?.fields.map((f) => renderField(action, f, onChange))}</div>
    </div>
  );
}

function SortableRuleCard({
  rule,
  expanded,
  onExpand,
  onUpdate,
  onDelete,
}: {
  rule: PrioritizationRule;
  expanded: boolean;
  onExpand: () => void;
  onUpdate: (rule: PrioritizationRule) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      data-testid={`rule-card-${rule.id}`}
      className="rounded border border-border bg-card"
    >
      {expanded ? (
        <div className="p-3 space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              {...listeners}
              className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <ToggleSwitch
              checked={rule.enabled}
              onChange={(val) => onUpdate({ ...rule, enabled: val })}
            />
            <input
              type="text"
              value={rule.name}
              onChange={(e) => onUpdate({ ...rule, name: e.target.value })}
              className="flex-1 rounded border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Rule name"
            />
            <button
              type="button"
              onClick={onExpand}
              className="text-xs text-muted-foreground hover:text-foreground whitespace-nowrap"
            >
              Done
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="text-destructive hover:text-destructive/80"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 pl-7">
            <ConditionEditor
              condition={rule.condition}
              onChange={(c) => onUpdate({ ...rule, condition: c })}
            />
            <ActionEditor action={rule.action} onChange={(a) => onUpdate({ ...rule, action: a })} />
          </div>
          <div className="pl-7">
            <p className="text-xs text-muted-foreground italic">
              If {describeCondition(rule.condition)} &rarr; {describeAction(rule.action)}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 p-3">
          <button
            type="button"
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground flex-shrink-0"
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <ToggleSwitch
            checked={rule.enabled}
            onChange={(val) => onUpdate({ ...rule, enabled: val })}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{rule.name || "Unnamed rule"}</p>
            <p className="text-xs text-muted-foreground truncate">
              If {describeCondition(rule.condition)} &rarr; {describeAction(rule.action)}
            </p>
          </div>
          <button
            type="button"
            onClick={onExpand}
            className="text-xs text-muted-foreground hover:text-foreground whitespace-nowrap"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-destructive hover:text-destructive/80"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export const PrioritizationTab = forwardRef<PrioritizationTabHandle, PrioritizationTabProps>(
  function PrioritizationTab(
    { habitatId, boardPrioritizationSettings, onUpdate, onSavingChange },
    ref,
  ) {
    const [enabled, setEnabled] = useState(true);
    const [fallbackToManual, setFallbackToManual] = useState(true);
    const [evaluateInterval, setEvaluateInterval] = useState("5");
    const [rules, setRules] = useState<PrioritizationRule[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [advancedText, setAdvancedText] = useState("");
    const [validationError, setValidationError] = useState<string | null>(null);

    const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId, onUpdate });

    useEffect(() => {
      onSavingChange?.(saving);
    }, [saving, onSavingChange]);

    useEffect(() => {
      if (boardPrioritizationSettings) {
        setEnabled(boardPrioritizationSettings.enabled);
        setFallbackToManual(boardPrioritizationSettings.fallbackToManual);
        setEvaluateInterval(boardPrioritizationSettings.evaluateIntervalMinutes.toString());
        setRules(boardPrioritizationSettings.rules);
      } else {
        setEnabled(false);
        setFallbackToManual(true);
        setEvaluateInterval("5");
        setRules([]);
      }
      setValidationError(null);
      setExpandedId(null);
    }, [boardPrioritizationSettings]);

    const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
      useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    );

    function handleDragEnd(event: DragEndEvent) {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = rules.findIndex((r) => r.id === active.id);
      const newIndex = rules.findIndex((r) => r.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(rules, oldIndex, newIndex).map((r, i) => ({ ...r, priority: i }));
      setRules(reordered);
    }

    function addRule() {
      const newRule: PrioritizationRule = {
        id: generateId(),
        name: "",
        enabled: true,
        condition: getDefaultCondition("overdue"),
        action: getDefaultAction("set_priority"),
        priority: rules.length,
      };
      setRules([...rules, newRule]);
      setExpandedId(newRule.id);
    }

    function updateRule(updated: PrioritizationRule) {
      setRules(rules.map((r) => (r.id === updated.id ? updated : r)));
    }

    function deleteRule(id: string) {
      setRules(rules.filter((r) => r.id !== id).map((r, i) => ({ ...r, priority: i })));
      if (expandedId === id) setExpandedId(null);
    }

    function toggleAdvanced() {
      if (!advancedOpen) {
        setAdvancedText(JSON.stringify(rules, null, 2));
        setValidationError(null);
      }
      setAdvancedOpen(!advancedOpen);
    }

    function handleAdvancedTextChange(text: string) {
      setAdvancedText(text);
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          setValidationError(null);
        } else {
          setValidationError("Rules must be a JSON array");
        }
      } catch (e) {
        setValidationError(`Invalid JSON: ${(e as Error).message}`);
      }
    }

    const handleSave = useCallback(async () => {
      setValidationError(null);

      let rulesToSave = rules;

      if (advancedOpen) {
        try {
          const parsed = JSON.parse(advancedText);
          if (!Array.isArray(parsed)) {
            setValidationError("Rules must be a JSON array");
            return;
          }
          const isValid = parsed.every(
            (r) =>
              r &&
              typeof r === "object" &&
              typeof r.id === "string" &&
              typeof r.name === "string" &&
              r.condition &&
              typeof r.condition.type === "string" &&
              r.action &&
              typeof r.action.type === "string",
          );
          if (!isValid) {
            setValidationError("Each rule must have id, name, condition.type, and action.type");
            return;
          }
          rulesToSave = parsed;
          setRules(parsed);
        } catch (e) {
          setValidationError(`Invalid JSON: ${(e as Error).message}`);
          return;
        }
      }

      const settings: PrioritizationSettings = {
        enabled,
        evaluateIntervalMinutes: parseInt(evaluateInterval, 10) || 5,
        rules: rulesToSave,
        fallbackToManual,
      };

      await saveSettings({ prioritizationSettings: settings }, "Prioritization rules saved");
    }, [
      saveSettings,
      enabled,
      evaluateInterval,
      rules,
      fallbackToManual,
      advancedOpen,
      advancedText,
    ]);

    useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Enable Prioritization Engine</p>
            <p className="text-xs text-muted-foreground">
              Automatically adjust task priorities based on configurable rules
            </p>
          </div>
          <ToggleSwitch checked={enabled} onChange={(val) => setEnabled(val)} />
        </div>

        {enabled && (
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label htmlFor="prio-eval-interval" className="text-sm font-medium">
                  Evaluate Interval (min)
                </label>
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

            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Rules</p>
              <Button onClick={addRule} size="sm">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Rule
              </Button>
            </div>

            {rules.length === 0 ? (
              <div className="rounded border border-border p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  No rules configured. Add a rule to start auto-prioritizing tasks.
                </p>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={rules.map((r) => r.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {rules.map((rule) => (
                      <SortableRuleCard
                        key={rule.id}
                        rule={rule}
                        expanded={expandedId === rule.id}
                        onExpand={() => setExpandedId(expandedId === rule.id ? null : rule.id)}
                        onUpdate={updateRule}
                        onDelete={() => deleteRule(rule.id)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            <div className="border border-border rounded-md">
              <button
                type="button"
                className="w-full px-3 py-2 text-sm font-medium cursor-pointer hover:bg-muted/50 flex items-center gap-2 text-left"
                onClick={toggleAdvanced}
              >
                {advancedOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Advanced Mode (JSON)
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 space-y-2 border-t border-border pt-3">
                  <textarea
                    data-testid="prio-rules-editor"
                    value={advancedText}
                    onChange={(e) => handleAdvancedTextChange(e.target.value)}
                    rows={8}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    spellCheck={false}
                  />
                  {validationError && (
                    <p data-testid="prio-validation-error" className="text-sm text-destructive">
                      {validationError}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Condition types: overdue, sla_approaching, due_soon, pending_duration,
                    dependency_count, rejection_count, mission_status, agent_idle, label_match,
                    priority_is, and, or
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Action types: set_priority, bump_priority, add_label, set_score_bonus
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);
