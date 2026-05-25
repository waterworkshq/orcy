import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { RichTextEditor } from '../ui/RichTextEditor.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import { notify } from '../../lib/toast.js';
import { useTemplates, useCreateMission } from '../../lib/useHabitatData.js';
import type { TaskPriority } from '../../types/index.js';

interface CreateMissionFormProps {
  open: boolean;
  onClose: () => void;
  habitatId: string;
}

export function CreateMissionForm({ open, onClose, habitatId }: CreateMissionFormProps) {
  const { columns, addFeature } = useHabitatStore();
  useTemplates(habitatId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [columnId, setColumnId] = useState('');
  const [labels, setLabels] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [slaMinutes, setSlaMinutes] = useState('');
  const createMission = useCreateMission(habitatId);

  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setAcceptanceCriteria('');
      setPriority('medium');
      setLabels('');
      setDueAt('');
      setSlaMinutes('');
    }
  }, [open]);

  useEffect(() => {
    if (open && columns.length > 0) {
      const firstNonTerminal = columns.find((c) => !c.isTerminal);
      setColumnId(firstNonTerminal?.id ?? columns[0]?.id ?? '');
    }
  }, [open, columns]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !columnId) return;

    try {
      const labelList = labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);

      const result = await createMission.mutateAsync({
        columnId,
        title: title.trim(),
        description: description.trim() || undefined,
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
        priority,
        labels: labelList.length > 0 ? labelList : undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        slaMinutes: slaMinutes ? parseInt(slaMinutes, 10) : undefined,
      });
      addFeature({
        ...result.feature,
        progress: {
          total: 0, pending: 0, claimed: 0, inProgress: 0,
          submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0,
        },
      });
      notify.success(`Mission "${title.trim()}" created`);
      onClose();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>Create Mission</DialogTitle>
          <DialogDescription>
            Add a new mission to this habitat.
          </DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Mission title"
                required
                maxLength={200}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Description</label>
              <RichTextEditor
                content={description}
                onChange={setDescription}
                placeholder="Mission description"
                minHeight="120px"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Acceptance Criteria</label>
              <RichTextEditor
                content={acceptanceCriteria}
                onChange={setAcceptanceCriteria}
                placeholder="What defines done for this mission"
                minHeight="80px"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Column</label>
                <select
                  value={columnId}
                  onChange={(e) => setColumnId(e.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Labels</label>
              <input
                type="text"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="auth, api, bug (comma-separated)"
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Due Date</label>
                <input
                  type="datetime-local"
                  value={dueAt}
                  onChange={e => setDueAt(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium">SLA (minutes)</label>
                <input
                  type="number"
                  min="1"
                  placeholder="e.g., 60"
                  value={slaMinutes}
                  onChange={e => setSlaMinutes(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>
        </DialogContent>

        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createMission.isPending} disabled={createMission.isPending || !title.trim()}>
            Create Mission
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
