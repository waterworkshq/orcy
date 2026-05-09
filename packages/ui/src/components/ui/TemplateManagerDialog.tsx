import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import type { FeatureTemplate, TaskPriority } from '../../types/index.js';

interface TemplateManagerDialogProps {
  boardId: string;
  open: boolean;
  onClose: () => void;
}

interface EditTemplateState {
  id: string | null;
  name: string;
  titlePattern: string;
  descriptionPattern: string;
  priority: TaskPriority;
  labels: string;
  requiredDomain: string;
}

const emptyEditState: EditTemplateState = {
  id: null,
  name: '',
  titlePattern: '',
  descriptionPattern: '',
  priority: 'medium',
  labels: '',
  requiredDomain: '',
};

export function TemplateManagerDialog({ boardId, open, onClose }: TemplateManagerDialogProps) {
  const [templates, setTemplates] = useState<FeatureTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<EditTemplateState | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (open) {
      loadTemplates();
    }
  }, [open, boardId]);

  async function loadTemplates() {
    setLoading(true);
    try {
      const result = await api.templates.list(boardId);
      setTemplates(result.templates);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function startCreate() {
    setEditing({ ...emptyEditState });
    setShowForm(true);
  }

  function startEdit(tmpl: FeatureTemplate) {
    setEditing({
      id: tmpl.id,
      name: tmpl.name,
      titlePattern: tmpl.titlePattern,
      descriptionPattern: tmpl.descriptionPattern,
      priority: tmpl.priority,
      labels: tmpl.labels.join(', '),
      requiredDomain: tmpl.requiredDomain ?? '',
    });
    setShowForm(true);
  }

  function cancelEdit() {
    setEditing(null);
    setShowForm(false);
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.titlePattern.trim()) {
      notify.error('Name and title pattern are required');
      return;
    }

    setSaving(true);
    try {
      const labelList = editing.labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);

      const data = {
        name: editing.name.trim(),
        titlePattern: editing.titlePattern.trim(),
        descriptionPattern: editing.descriptionPattern.trim(),
        priority: editing.priority,
        labels: labelList,
        requiredDomain: editing.requiredDomain || null,
      };

      if (editing.id) {
        await api.templates.update(editing.id, data);
        notify.success('Template updated');
      } else {
        await api.templates.create(boardId, data);
        notify.success('Template created');
      }

      setEditing(null);
      setShowForm(false);
      loadTemplates();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.templates.delete(id);
      notify.success('Template deleted');
      loadTemplates();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  const globalTemplates = templates.filter((t) => !t.boardId);
  const boardTemplates = templates.filter((t) => t.boardId);

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Mission Templates</DialogTitle>
      </DialogHeader>
      <DialogContent>
        {!showForm ? (
          <>
            <div className="mb-4">
              <Button onClick={startCreate}>+ New Mission Template</Button>
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No mission templates yet. Create one to get started.</p>
            ) : (
              <div className="space-y-6">
                {globalTemplates.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-muted-foreground">Global Mission Templates</h4>
                    <div className="space-y-2">
                      {globalTemplates.map((tmpl) => (
                        <div
                          key={tmpl.id}
                          className="flex items-center justify-between rounded border p-3"
                        >
                          <div>
                            <p className="font-medium">{tmpl.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {tmpl.titlePattern} · {tmpl.priority} · used {tmpl.usageCount}x
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(tmpl)}
                          >
                            Edit
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {boardTemplates.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-muted-foreground">Habitat Mission Templates</h4>
                    <div className="space-y-2">
                      {boardTemplates.map((tmpl) => (
                        <div
                          key={tmpl.id}
                          className="flex items-center justify-between rounded border p-3"
                        >
                          <div>
                            <p className="font-medium">{tmpl.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {tmpl.titlePattern} · {tmpl.priority} · used {tmpl.usageCount}x
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => startEdit(tmpl)}
                            >
                              Edit
                            </Button>
                            {!tmpl.isDefault && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDelete(tmpl.id)}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Name *</label>
              <input
                type="text"
                value={editing!.name}
                onChange={(e) => setEditing({ ...editing!, name: e.target.value })}
                placeholder="Bug Fix"
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Title Pattern *</label>
              <input
                type="text"
                value={editing!.titlePattern}
                onChange={(e) => setEditing({ ...editing!, titlePattern: e.target.value })}
                placeholder="Fix: "
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Description Pattern</label>
              <textarea
                value={editing!.descriptionPattern}
                onChange={(e) => setEditing({ ...editing!, descriptionPattern: e.target.value })}
                placeholder="## Steps to Reproduce&#10;...&#10;&#10;## Expected Behavior&#10;..."
                rows={4}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Priority</label>
                <select
                  value={editing!.priority}
                  onChange={(e) => setEditing({ ...editing!, priority: e.target.value as TaskPriority })}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Labels</label>
                <input
                  type="text"
                  value={editing!.labels}
                  onChange={(e) => setEditing({ ...editing!, labels: e.target.value })}
                  placeholder="bug, urgent (comma-separated)"
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Required Domain</label>
              <select
                value={editing!.requiredDomain}
                onChange={(e) => setEditing({ ...editing!, requiredDomain: e.target.value })}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Any domain</option>
                <option value="frontend">Frontend</option>
                <option value="backend">Backend</option>
                <option value="devops">DevOps</option>
                <option value="testing">Testing</option>
              </select>
            </div>
          </div>
        )}
      </DialogContent>
      <DialogFooter>
        {showForm ? (
          <>
            <Button
              variant="ghost"
              onClick={cancelEdit}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {editing?.id ? 'Update' : 'Create'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Done</Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
