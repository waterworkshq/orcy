import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import { NumberField } from '../../ui/NumberField.js';
import { Button } from '../../ui/Button.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { api } from '../../../api/index.js';
import { notify } from '../../../lib/toast.js';
import { queryKeys } from '../../../lib/queryKeys.js';
import type { ReviewRule, ReviewRuleStrategy, ReviewRuleCreateInput, ReviewRuleUpdateInput } from '../../../types/index.js';

interface ReviewRulesTabProps {
  habitatId: string;
}

const STRATEGY_OPTIONS: Array<{ value: ReviewRuleStrategy; label: string }> = [
  { value: 'domain_expert', label: 'Domain Expert' },
  { value: 'round_robin', label: 'Round Robin' },
  { value: 'least_loaded', label: 'Least Loaded' },
  { value: 'random', label: 'Random' },
  { value: 'fixed', label: 'Fixed Reviewers' },
];

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'];

interface RuleFormData {
  name: string;
  enabled: number;
  priority: number;
  matchDomain: string;
  matchPriority: string;
  matchLabels: string;
  assignmentStrategy: ReviewRuleStrategy;
  requiredReviews: string;
  antiSelfReview: number;
}

const DEFAULT_FORM: RuleFormData = {
  name: '',
  enabled: 1,
  priority: 0,
  matchDomain: '',
  matchPriority: '',
  matchLabels: '',
  assignmentStrategy: 'domain_expert',
  requiredReviews: '1',
  antiSelfReview: 1,
};

export function ReviewRulesTab({ habitatId }: ReviewRulesTabProps) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormData>(DEFAULT_FORM);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: rules = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.reviewRules.list(habitatId),
    queryFn: () => api.reviewRules.list(habitatId).then(r => r.reviewRules),
    enabled: !!habitatId,
  });

  const createMutation = useMutation({
    mutationFn: (body: ReviewRuleCreateInput) => api.reviewRules.create(habitatId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewRules.list(habitatId) });
      notify.success('Review rule created');
    },
    onError: (err: Error) => { notify.error(err.message); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReviewRuleUpdateInput }) => api.reviewRules.update(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewRules.list(habitatId) });
      notify.success('Review rule updated');
    },
    onError: (err: Error) => { notify.error(err.message); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.reviewRules.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewRules.list(habitatId) });
      notify.success('Review rule deleted');
    },
    onError: (err: Error) => { notify.error(err.message); },
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  function startEdit(rule: ReviewRule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      enabled: rule.enabled,
      priority: rule.priority,
      matchDomain: rule.matchDomain ?? '',
      matchPriority: rule.matchPriority ?? '',
      matchLabels: rule.matchLabels.join(', '),
      assignmentStrategy: rule.assignmentStrategy,
      requiredReviews: rule.requiredReviews.toString(),
      antiSelfReview: rule.antiSelfReview,
    });
  }

  function startCreate() {
    setEditingId('new');
    setForm(DEFAULT_FORM);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(DEFAULT_FORM);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      notify.error('Rule name is required');
      return;
    }

    const createBody: ReviewRuleCreateInput = {
      name: form.name.trim(),
      enabled: form.enabled,
      priority: form.priority,
      matchDomain: form.matchDomain || null,
      matchPriority: form.matchPriority || null,
      matchLabels: form.matchLabels ? form.matchLabels.split(',').map(s => s.trim()).filter(Boolean) : [],
      assignmentStrategy: form.assignmentStrategy,
      requiredReviews: parseInt(form.requiredReviews, 10) || 1,
      antiSelfReview: form.antiSelfReview,
    };

    try {
      if (editingId === 'new') {
        await createMutation.mutateAsync(createBody);
      } else if (editingId) {
        const updateBody: ReviewRuleUpdateInput = { ...createBody };
        await updateMutation.mutateAsync({ id: editingId, body: updateBody });
      }
      setEditingId(null);
      setForm(DEFAULT_FORM);
    } catch {
      // Error handled by mutation onError
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await deleteMutation.mutateAsync(deleteId);
      setDeleteId(null);
      if (editingId === deleteId) {
        setEditingId(null);
        setForm(DEFAULT_FORM);
      }
    } catch {
      // Error handled by mutation onError
    }
  }

  function toggleRuleEnabled(rule: ReviewRule) {
    updateMutation.mutate({ id: rule.id, body: { enabled: rule.enabled ? 0 : 1 } });
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading review rules...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Review Rules</p>
          <p className="text-xs text-muted-foreground">Configure automatic reviewer assignment when tasks are submitted</p>
        </div>
        {editingId !== 'new' && (
          <Button onClick={startCreate} disabled={saving}>Add Rule</Button>
        )}
      </div>

      {rules.length === 0 && editingId !== 'new' && (
        <div className="rounded border border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">No review rules configured. Tasks will be approved without review.</p>
        </div>
      )}

      {rules.map(rule => (
        <div key={rule.id} className="rounded border border-border">
          {editingId === rule.id ? (
            <div className="space-y-3 p-4">
              <RuleFormFields form={form} setForm={setForm} />
              <div className="flex gap-2 pt-2 border-t border-border">
                <Button onClick={handleSave} loading={saving}>Save</Button>
                <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <ToggleSwitch checked={rule.enabled === 1} onChange={() => toggleRuleEnabled(rule)} />
                <div>
                  <p className="text-sm font-medium">{rule.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {rule.requiredReviews} review{rule.requiredReviews > 1 ? 's' : ''} via {STRATEGY_OPTIONS.find(s => s.value === rule.assignmentStrategy)?.label ?? rule.assignmentStrategy}
                    {rule.matchDomain ? ` · domain: ${rule.matchDomain}` : ''}
                    {rule.matchPriority ? ` · priority: ${rule.matchPriority}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => startEdit(rule)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-xs text-destructive hover:text-destructive/80"
                  onClick={() => setDeleteId(rule.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {editingId === 'new' && (
        <div className="rounded border border-border">
          <div className="space-y-3 p-4">
            <p className="text-sm font-medium">New Review Rule</p>
            <RuleFormFields form={form} setForm={setForm} />
            <div className="flex gap-2 pt-2 border-t border-border">
              <Button onClick={handleSave} loading={saving}>Create</Button>
              <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      <details className="border border-border rounded-md">
        <summary className="px-3 py-2 text-sm font-medium cursor-pointer hover:bg-muted/50">
          How review rules work
        </summary>
        <div className="px-3 pb-3 text-xs text-muted-foreground space-y-1">
          <p>When a task is submitted, review rules are matched in priority order. The first matching rule assigns reviewers.</p>
          <p>Leave match fields empty to match all tasks. Set multiple conditions to narrow the match.</p>
          <p>The task stays in &quot;submitted&quot; until all required reviewers approve it.</p>
        </div>
      </details>

      <ConfirmDialog
        open={deleteId !== null}
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
        title="Delete Review Rule"
        description="Are you sure you want to delete this review rule? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}

function RuleFormFields({ form, setForm }: { form: RuleFormData; setForm: React.Dispatch<React.SetStateAction<RuleFormData>> }) {
  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rule-name">Rule Name</label>
        <input
          id="rule-name"
          type="text"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="e.g. Backend tasks require 2 reviews"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rule-strategy">Assignment Strategy</label>
          <select
            id="rule-strategy"
            value={form.assignmentStrategy}
            onChange={e => setForm(f => ({ ...f, assignmentStrategy: e.target.value as ReviewRuleStrategy }))}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {STRATEGY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
        <NumberField
          label="Required Reviews"
          value={form.requiredReviews}
          onChange={v => setForm(f => ({ ...f, requiredReviews: v }))}
          min={1}
          max={10}
          id="rule-required-reviews"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rule-domain">Match Domain (optional)</label>
          <select
            id="rule-domain"
            value={form.matchDomain}
            onChange={e => setForm(f => ({ ...f, matchDomain: e.target.value }))}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Any domain</option>
            <option value="frontend">Frontend</option>
            <option value="backend">Backend</option>
            <option value="devops">DevOps</option>
            <option value="testing">Testing</option>
            <option value="fullstack">Fullstack</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rule-priority">Match Priority (optional)</label>
          <select
            id="rule-priority"
            value={form.matchPriority}
            onChange={e => setForm(f => ({ ...f, matchPriority: e.target.value }))}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Any priority</option>
            {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rule-labels">Match Labels (comma-separated, optional)</label>
        <input
          id="rule-labels"
          type="text"
          value={form.matchLabels}
          onChange={e => setForm(f => ({ ...f, matchLabels: e.target.value }))}
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="e.g. security, infra"
        />
      </div>
      <NumberField
        label="Priority Order"
        value={form.priority.toString()}
        onChange={v => setForm(f => ({ ...f, priority: parseInt(v, 10) || 0 }))}
        min={0}
        max={100}
        id="rule-priority-order"
      />
      <div className="space-y-2 pt-2 border-t border-border">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.antiSelfReview === 1}
            onChange={e => setForm(f => ({ ...f, antiSelfReview: e.target.checked ? 1 : 0 }))}
            className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
          />
          <div>
            <span className="text-sm">Prevent Self-Review</span>
            <p className="text-xs text-muted-foreground">Don't allow the task submitter to review their own task</p>
          </div>
        </label>
      </div>
    </>
  );
}
