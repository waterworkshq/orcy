import React, { useState, useEffect } from 'react';
import { CronExpressionParser } from 'cron-parser';
import { Button } from '../../ui/Button.js';
import type { ScheduledTask, TaskTemplateEntry, MissionTemplate, TaskPriority, ScheduleType } from '../../../types/index.js';

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
  templates: MissionTemplate[];
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
  missionTitle: string;
  missionDescription: string;
  missionPriority: TaskPriority;
  missionLabels: string[];
  missionDomain: string | null;
  tasksTemplate: TaskTemplateEntry[];
}

function TokenHints({ testId }: { testId: string }) {
  return (
    <details className="mt-1">
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Available tokens
      </summary>
      <div className="mt-1 space-y-0.5 pl-2 text-xs text-muted-foreground" data-testid={testId}>
        <p><code className="text-[var(--accent)]">{'{{date}}'}</code> — Current date (YYYY-MM-DD) in the selected timezone</p>
        <p><code className="text-[var(--accent)]">{'{{counter}}'}</code> — Run number (increments each execution)</p>
        <p className="italic">Example: <code className="text-[var(--accent)]">{'"Sprint {{counter}} — {{date}}"'}</code> → <code>{'"Sprint 7 — 2026-05-19"'}</code></p>
      </div>
    </details>
  );
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
  const [missionTitle, setMissionTitle] = useState('');
  const [missionDescription, setMissionDescription] = useState('');
  const [missionPriority, setMissionPriority] = useState<TaskPriority>('medium');
  const [missionLabels, setMissionLabels] = useState('');
  const [missionDomain, setMissionDomain] = useState('');
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
      setMissionTitle(existing.missionTitle);
      setMissionDescription(existing.missionDescription);
      setMissionPriority(existing.missionPriority);
      setMissionLabels(existing.missionLabels.join(', '));
      setMissionDomain(existing.missionDomain ?? '');
    }
  }, [existing]);

  useEffect(() => {
    if (templateId) {
      const tmpl = templates.find((t) => t.id === templateId);
      if (tmpl) {
        if (!existing) {
          setMissionTitle(tmpl.titlePattern);
          setMissionDescription(tmpl.descriptionPattern);
          setMissionPriority(tmpl.priority);
          setMissionLabels(tmpl.labels.join(', '));
          setMissionDomain(tmpl.requiredDomain ?? '');
        }
      }
    }
  }, [templateId, templates, existing]);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!missionTitle.trim()) errs.missionTitle = 'Mission title is required';
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
      missionTitle: missionTitle.trim(),
      missionDescription: missionDescription.trim(),
      missionPriority,
      missionLabels: missionLabels ? missionLabels.split(',').map((l) => l.trim()).filter(Boolean) : [],
      missionDomain: missionDomain.trim() || null,
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
          <p className="text-sm font-medium mb-2">Mission Overrides</p>
        </div>

        <div className="col-span-2">
          <label htmlFor="st-mission-title" className="text-sm font-medium">Mission Title</label>
          <input
            id="st-mission-title"
            data-testid="st-mission-title"
            type="text"
            value={missionTitle}
            onChange={(e) => setMissionTitle(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {errors.missionTitle && <p className="text-xs text-destructive mt-1">{errors.missionTitle}</p>}
          <TokenHints testId="title-token-hints" />
        </div>

        <div>
          <label htmlFor="st-mission-desc" className="text-sm font-medium">Mission Description</label>
          <input
            id="st-mission-desc"
            data-testid="st-mission-desc"
            type="text"
            value={missionDescription}
            onChange={(e) => setMissionDescription(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <TokenHints testId="desc-token-hints" />
        </div>

        <div>
          <label htmlFor="st-feature-priority" className="text-sm font-medium">Priority</label>
          <select
            id="st-feature-priority"
            data-testid="st-feature-priority"
            value={missionPriority}
            onChange={(e) => setMissionPriority(e.target.value as TaskPriority)}
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
            value={missionLabels}
            onChange={(e) => setMissionLabels(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="st-feature-domain" className="text-sm font-medium">Domain</label>
          <input
            id="st-feature-domain"
            data-testid="st-feature-domain"
            type="text"
            value={missionDomain}
            onChange={(e) => setMissionDomain(e.target.value)}
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
