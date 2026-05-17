import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { useTemplates } from '../../lib/useHabitatData.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys.js';
import type { MissionTemplate, TaskPriority } from '../../types/index.js';

interface TemplateManagerDialogProps {
  habitatId: string;
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

export function TemplateManagerDialog({ habitatId, open, onClose }: TemplateManagerDialogProps) {
  const qc = useQueryClient();
  const { data: templatesData, isLoading } = useTemplates(habitatId);
  const templates = templatesData?.templates ?? [];
  const [editing, setEditing] = useState<EditTemplateState | null>(null);
  const [showForm, setShowForm] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (edit: EditTemplateState) => {
      const labelList = edit.labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);

      const data = {
        name: edit.name.trim(),
        titlePattern: edit.titlePattern.trim(),
        descriptionPattern: edit.descriptionPattern.trim(),
        priority: edit.priority,
        labels: labelList,
        requiredDomain: edit.requiredDomain || null,
      };

      if (edit.id) {
        await api.templates.update(edit.id, data);
      } else {
        await api.templates.create(habitatId, data);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.templates.list(habitatId) });
      notify.success(editing?.id ? 'Template updated' : 'Template created');
      setEditing(null);
      setShowForm(false);
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.templates.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.templates.list(habitatId) });
      notify.success('Template deleted');
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  function startCreate() {
    setEditing({ ...emptyEditState });
    setShowForm(true);
  }

  function startEdit(tmpl: MissionTemplate) {
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

  function handleSave() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.titlePattern.trim()) {
      notify.error('Name and title pattern are required');
      return;
    }
    saveMutation.mutate(editing);
  }

  function handleDelete(id: string) {
    deleteMutation.mutate(id);
  }

  const globalTemplates = templates.filter((t) => !t.habitatId);
  const boardTemplates = templates.filter((t) => t.habitatId);

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

            {isLoading ? (
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
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saveMutation.isPending}>
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
