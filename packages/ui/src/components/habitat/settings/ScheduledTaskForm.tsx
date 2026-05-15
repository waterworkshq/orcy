import React, { useState, useEffect } from 'react';
import { CronExpressionParser } from 'cron-parser';
import { Button } from '../../ui/Button.js';
import type { ScheduledTask, TaskTemplateEntry, FeatureTemplate, TaskPriority, ScheduleType } from '../../../types/index.js';

const CRON_PATTERNS = [
  { label: 'Every Monday 9am', value: '0 9 * * 1' },
  { label: 'First of month', value: '0 0 1 * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
];

const IANA_TIMEZONES: string[] = (() => {
  const tzs: string[] = [];
  tzs.push('UTC');
  try {
    const raw = Intl.supportedValuesOf('timeZone');
    for (const tz of raw) {
      if (tz !== 'UTC') tzs.push(tz);
    }
  } catch {
    tzs.push(
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
      'Australia/Sydney', 'Pacific/Auckland',
    );
  }
  return tzs;
})();

interface ScheduledTaskFormProps {
  existing: ScheduledTask | null;
  templates: FeatureTemplate[];
  saving: boolean;
  onSave: (data: ScheduledTaskFormData) => void;
  onCancel: () => void;
}

export interface ScheduledTaskFormData {
  name: string;
  description: string;
  templateId: string | null;
  scheduleType: ScheduleType;
  cronExpression: string | null;
  intervalMinutes: number | null;
  scheduledAt: string | null;
  timezone: string;
  featureTitle: string;
  featureDescription: string;
  featurePriority: TaskPriority;
  featureLabels: string[];
  featureDomain: string | null;
  tasksTemplate: TaskTemplateEntry[];
}

function priorityOptions(): { value: TaskPriority; label: string }[] {
  return [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'critical', label: 'Critical' },
  ];
}

export function ScheduledTaskForm({
  existing,
  templates,
  saving,
  onSave,
  onCancel,
}: ScheduledTaskFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [scheduleType, setScheduleType] = useState<ScheduleType>('cron');
  const [cronExpression, setCronExpression] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [scheduledAt, setScheduledAt] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [featureTitle, setFeatureTitle] = useState('');
  const [featureDescription, setFeatureDescription] = useState('');
  const [featurePriority, setFeaturePriority] = useState<TaskPriority>('medium');
  const [featureLabels, setFeatureLabels] = useState('');
  const [featureDomain, setFeatureDomain] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description);
      setTemplateId(existing.templateId);
      setScheduleType(existing.scheduleType);
      setCronExpression(existing.cronExpression ?? '');
      setIntervalMinutes(existing.intervalMinutes?.toString() ?? '60');
      setScheduledAt(existing.scheduledAt ?? '');
      setTimezone(existing.timezone);
      setFeatureTitle(existing.featureTitle);
      setFeatureDescription(existing.featureDescription);
      setFeaturePriority(existing.featurePriority);
      setFeatureLabels(existing.featureLabels.join(', '));
      setFeatureDomain(existing.featureDomain ?? '');
    }
  }, [existing]);

  useEffect(() => {
    if (templateId) {
      const tmpl = templates.find((t) => t.id === templateId);
      if (tmpl) {
        if (!existing) {
          setFeatureTitle(tmpl.titlePattern);
          setFeatureDescription(tmpl.descriptionPattern);
          setFeaturePriority(tmpl.priority);
          setFeatureLabels(tmpl.labels.join(', '));
          setFeatureDomain(tmpl.requiredDomain ?? '');
        }
      }
    }
  }, [templateId, templates, existing]);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!featureTitle.trim()) errs.featureTitle = 'Feature title is required';
    if (scheduleType === 'cron' && !cronExpression.trim()) errs.cronExpression = 'Cron expression is required';
    if (scheduleType === 'cron' && cronExpression.trim() && !errs.cronExpression) {
      try {
        CronExpressionParser.parse(cronExpression.trim());
      } catch {
        errs.cronExpression = 'Invalid cron expression';
      }
    }
    if (scheduleType === 'interval' && (!intervalMinutes || parseInt(intervalMinutes) < 1)) {
      errs.intervalMinutes = 'Interval must be >= 1 minute';
    }
    if (scheduleType === 'once' && !scheduledAt) errs.scheduledAt = 'Scheduled time is required';
    if (!IANA_TIMEZONES.includes(timezone)) errs.timezone = 'Invalid timezone';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    onSave({
      name: name.trim(),
      description: description.trim(),
      templateId,
      scheduleType,
      cronExpression: scheduleType === 'cron' ? cronExpression.trim() : null,
      intervalMinutes: scheduleType === 'interval' ? parseInt(intervalMinutes, 10) : null,
      scheduledAt: scheduleType === 'once' ? scheduledAt : null,
      timezone,
      featureTitle: featureTitle.trim(),
      featureDescription: featureDescription.trim(),
      featurePriority,
      featureLabels: featureLabels ? featureLabels.split(',').map((l) => l.trim()).filter(Boolean) : [],
      featureDomain: featureDomain.trim() || null,
      tasksTemplate: existing?.tasksTemplate ?? [],
    });
  }

  return (
    <form onSubmit={handleSubmit} data-testid="scheduled-task-form" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {existing ? 'Edit Scheduled Task' : 'New Scheduled Task'}
        </h3>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label htmlFor="st-name" className="text-sm font-medium">Name</label>
          <input
            id="st-name"
            data-testid="st-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
        </div>

        <div className="col-span-2">
          <label htmlFor="st-description" className="text-sm font-medium">Description</label>
          <input
            id="st-description"
            data-testid="st-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="st-template" className="text-sm font-medium">Template (optional)</label>
          <select
            id="st-template"
            data-testid="st-template"
            value={templateId ?? ''}
            onChange={(e) => setTemplateId(e.target.value || null)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="">None</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="st-schedule-type" className="text-sm font-medium">Schedule Type</label>
          <select
            id="st-schedule-type"
            data-testid="st-schedule-type"
            value={scheduleType}
            onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="cron">Cron</option>
            <option value="interval">Interval</option>
            <option value="once">One-time</option>
          </select>
        </div>

        {scheduleType === 'cron' && (
          <div className="col-span-2">
            <label htmlFor="st-cron" className="text-sm font-medium">Cron Expression</label>
            <input
              id="st-cron"
              data-testid="st-cron-expression"
              type="text"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="0 9 * * 1"
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
            />
            {errors.cronExpression && <p className="text-xs text-destructive mt-1">{errors.cronExpression}</p>}
            <details className="mt-1">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                Common patterns
              </summary>
              <div className="mt-1 space-y-0.5" data-testid="cron-patterns">
                {CRON_PATTERNS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className="block text-xs font-mono text-muted-foreground hover:text-foreground"
                    onClick={() => setCronExpression(p.value)}
                  >
                    {p.value} — {p.label}
                  </button>
                ))}
              </div>
            </details>
          </div>
        )}

        {scheduleType === 'interval' && (
          <div>
            <label htmlFor="st-interval" className="text-sm font-medium">Interval (minutes)</label>
            <input
              id="st-interval"
              data-testid="st-interval-minutes"
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
            {errors.intervalMinutes && <p className="text-xs text-destructive mt-1">{errors.intervalMinutes}</p>}
          </div>
        )}

        {scheduleType === 'once' && (
          <div>
            <label htmlFor="st-scheduled-at" className="text-sm font-medium">Run At</label>
            <input
              id="st-scheduled-at"
              data-testid="st-scheduled-at"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
            {errors.scheduledAt && <p className="text-xs text-destructive mt-1">{errors.scheduledAt}</p>}
          </div>
        )}

        <div>
          <label htmlFor="st-timezone" className="text-sm font-medium">Timezone</label>
          <select
            id="st-timezone"
            data-testid="st-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            {IANA_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
          {errors.timezone && <p className="text-xs text-destructive mt-1">{errors.timezone}</p>}
        </div>

        <div className="col-span-2 border-t border-border pt-4">
          <p className="text-sm font-medium mb-2">Feature Overrides</p>
        </div>

        <div className="col-span-2">
          <label htmlFor="st-feature-title" className="text-sm font-medium">Feature Title</label>
          <input
            id="st-feature-title"
            data-testid="st-feature-title"
            type="text"
            value={featureTitle}
            onChange={(e) => setFeatureTitle(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {errors.featureTitle && <p className="text-xs text-destructive mt-1">{errors.featureTitle}</p>}
        </div>

        <div>
          <label htmlFor="st-feature-desc" className="text-sm font-medium">Feature Description</label>
          <input
            id="st-feature-desc"
            data-testid="st-feature-desc"
            type="text"
            value={featureDescription}
            onChange={(e) => setFeatureDescription(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="st-feature-priority" className="text-sm font-medium">Priority</label>
          <select
            id="st-feature-priority"
            data-testid="st-feature-priority"
            value={featurePriority}
            onChange={(e) => setFeaturePriority(e.target.value as TaskPriority)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            {priorityOptions().map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="st-feature-labels" className="text-sm font-medium">Labels (comma-separated)</label>
          <input
            id="st-feature-labels"
            data-testid="st-feature-labels"
            type="text"
            value={featureLabels}
            onChange={(e) => setFeatureLabels(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="st-feature-domain" className="text-sm font-medium">Domain</label>
          <input
            id="st-feature-domain"
            data-testid="st-feature-domain"
            type="text"
            value={featureDomain}
            onChange={(e) => setFeatureDomain(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={saving} loading={saving} data-testid="st-submit">
          {existing ? 'Update' : 'Create'}
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
