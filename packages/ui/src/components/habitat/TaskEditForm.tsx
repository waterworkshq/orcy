import React, { useState } from 'react';
import { Button } from '../ui/Button.js';
import { RichTextEditor } from '../ui/RichTextEditor.js';

interface EditFormProps {
  editForm: {
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    labels: string;
    requiredDomain: string;
    requiredCapabilities: string[];
  };
  editDueAt: string;
  editSlaMinutes: string;
  editEstimatedMinutes: string;
  retryForm: {
    maxRetries: string;
    backoffBase: string;
    backoffMultiplier: string;
    maxBackoff: string;
    escalateToHuman: boolean;
  };
  onFormChange: (form: EditFormProps['editForm']) => void;
  onDueAtChange: (v: string) => void;
  onSlaMinutesChange: (v: string) => void;
  onEstimatedMinutesChange: (v: string) => void;
  onRetryFormChange: (form: EditFormProps['retryForm']) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
}

export function TaskEditForm({
  editForm,
  editEstimatedMinutes,
  retryForm,
  onFormChange,
  onEstimatedMinutesChange,
  onRetryFormChange,
  onSubmit,
  onCancel,
}: EditFormProps) {
  const [capInput, setCapInput] = useState('');

  function addCapability() {
    const trimmed = capInput.trim();
    if (trimmed && !editForm.requiredCapabilities.includes(trimmed)) {
      onFormChange({ ...editForm, requiredCapabilities: [...editForm.requiredCapabilities, trimmed] });
      setCapInput('');
    }
  }

  function removeCapability(cap: string) {
    onFormChange({ ...editForm, requiredCapabilities: editForm.requiredCapabilities.filter((c) => c !== cap) });
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onSubmit();
      }}
    >
      <input
        value={editForm.title}
        onChange={(e) => onFormChange({ ...editForm, title: e.target.value })}
        className="mb-2 w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        required
      />
      <div className="mb-2">
        <RichTextEditor
          content={editForm.description}
          onChange={(html) => onFormChange({ ...editForm, description: html })}
          placeholder="Task description..."
          minHeight="100px"
        />
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <select
          value={editForm.priority}
          onChange={(e) => onFormChange({ ...editForm, priority: e.target.value as 'low' | 'medium' | 'high' | 'critical' })}
          className="rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <select
          value={editForm.requiredDomain}
          onChange={(e) => onFormChange({ ...editForm, requiredDomain: e.target.value })}
          className="rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">Any domain</option>
          <option value="frontend">Frontend</option>
          <option value="backend">Backend</option>
          <option value="devops">DevOps</option>
          <option value="testing">Testing</option>
        </select>
      </div>
      <div className="mb-2">
        <label className="mb-1 block text-xs font-medium">Required Capabilities</label>
        <div className="flex flex-wrap gap-1 mb-2">
          {editForm.requiredCapabilities.map((cap) => (
            <span
              key={cap}
              className="glass-badge inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium"
            >
              {cap}
              <button
                type="button"
                onClick={() => removeCapability(cap)}
                className="ml-1 inline-flex items-center justify-center rounded-full w-4 h-4 hover:bg-foreground/10 text-xs leading-none"
                aria-label={`Remove ${cap}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Add capability (e.g., typescript)"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCapability();
              }
            }}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <Button type="button" variant="outline" size="sm" onClick={addCapability}>Add</Button>
        </div>
      </div>
      <div className="mb-2">
        <label className="mb-1 block text-xs font-medium">Estimated Time (minutes)</label>
        <input
          type="number"
          min="1"
          placeholder="e.g., 120"
          value={editEstimatedMinutes}
          onChange={(e) => onEstimatedMinutesChange(e.target.value)}
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div className="mb-2 border-t pt-2">
        <label className="mb-1 block text-xs font-medium">Retry Policy</label>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Max Retries</label>
            <input
              type="number"
              min="0"
              max="10"
              placeholder="3"
              value={retryForm.maxRetries}
              onChange={(e) => onRetryFormChange({ ...retryForm, maxRetries: e.target.value })}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Backoff Base (sec)</label>
            <input
              type="number"
              min="1"
              placeholder="60"
              value={retryForm.backoffBase}
              onChange={(e) => onRetryFormChange({ ...retryForm, backoffBase: e.target.value })}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Backoff Multiplier</label>
            <input
              type="number"
              min="1"
              step="0.5"
              placeholder="2"
              value={retryForm.backoffMultiplier}
              onChange={(e) => onRetryFormChange({ ...retryForm, backoffMultiplier: e.target.value })}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Max Backoff (sec)</label>
            <input
              type="number"
              min="1"
              placeholder="3600"
              value={retryForm.maxBackoff}
              onChange={(e) => onRetryFormChange({ ...retryForm, maxBackoff: e.target.value })}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={retryForm.escalateToHuman}
            onChange={(e) => onRetryFormChange({ ...retryForm, escalateToHuman: e.target.checked })}
            className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
          />
          <span className="text-xs text-muted-foreground">Escalate to human after max retries</span>
        </label>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm">Save</Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
