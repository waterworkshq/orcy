import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { useTemplates } from "../../lib/useHabitatData.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys.js";
import type {
  MissionTemplate,
  TaskPriority,
  TaskTemplateEntry,
  WorkflowTemplateDefinition,
} from "../../types/index.js";
import { WorkflowTemplateEditor } from "../workflow/WorkflowTemplateEditor.js";

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
  tasksTemplate: TaskTemplateEntry[];
  workflowTemplate: WorkflowTemplateDefinition | null;
}

const emptyEditState: EditTemplateState = {
  id: null,
  name: "",
  titlePattern: "",
  descriptionPattern: "",
  priority: "medium",
  labels: "",
  requiredDomain: "",
  tasksTemplate: [],
  workflowTemplate: null,
};

const EMPTY_WORKFLOW: WorkflowTemplateDefinition = { gates: [] };

export function TemplateManagerDialog({ habitatId, open, onClose }: TemplateManagerDialogProps) {
  const qc = useQueryClient();
  const { data: templatesData, isLoading } = useTemplates(habitatId);
  const templates = templatesData?.templates ?? [];
  const [editing, setEditing] = useState<EditTemplateState | null>(null);
  const [showForm, setShowForm] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (edit: EditTemplateState) => {
      const labelList = edit.labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);

      const data = {
        name: edit.name.trim(),
        titlePattern: edit.titlePattern.trim(),
        descriptionPattern: edit.descriptionPattern.trim(),
        priority: edit.priority,
        labels: labelList,
        requiredDomain: edit.requiredDomain || null,
        tasksTemplate: edit.tasksTemplate,
        workflowTemplate: edit.workflowTemplate,
      };

      if (edit.id) {
        await api.templates.update(edit.id, data);
      } else {
        await api.templates.create(habitatId, data);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.templates.list(habitatId) });
      notify.success(editing?.id ? "Template updated" : "Template created");
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
      notify.success("Template deleted");
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
      labels: tmpl.labels.join(", "),
      requiredDomain: tmpl.requiredDomain ?? "",
      tasksTemplate: tmpl.tasksTemplate ?? [],
      workflowTemplate: tmpl.workflowTemplate ?? null,
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
      notify.error("Name and title pattern are required");
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
    <Dialog
      open={open}
      onClose={onClose}
      contentClassName={showForm ? "max-w-4xl max-h-[90vh] overflow-y-auto" : undefined}
    >
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
              <p className="text-sm text-muted-foreground">
                No mission templates yet. Create one to get started.
              </p>
            ) : (
              <div className="space-y-6">
                {globalTemplates.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                      Global Mission Templates
                    </h4>
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
                          <Button variant="ghost" size="sm" onClick={() => startEdit(tmpl)}>
                            Edit
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {boardTemplates.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                      Habitat Mission Templates
                    </h4>
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
                            <Button variant="ghost" size="sm" onClick={() => startEdit(tmpl)}>
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
                  onChange={(e) =>
                    setEditing({ ...editing!, priority: e.target.value as TaskPriority })
                  }
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

            {/* Task Templates section */}
            <div className="border-t border-border pt-4" data-testid="task-templates-section">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold">
                  Task Templates ({editing!.tasksTemplate.length})
                </h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEditing({
                      ...editing!,
                      tasksTemplate: [...editing!.tasksTemplate, { title: "", description: "" }],
                    })
                  }
                  data-testid="add-task-template"
                >
                  + Add Task
                </Button>
              </div>
              <div className="space-y-2">
                {editing!.tasksTemplate.map((task, taskIndex) => (
                  <div
                    key={taskIndex}
                    data-testid={`task-template-row-${taskIndex}`}
                    className="grid grid-cols-12 gap-2 items-end rounded border border-border p-2"
                  >
                    <div className="col-span-2">
                      <label className="text-xs font-medium">Key</label>
                      <input
                        type="text"
                        data-testid={`task-key-${taskIndex}`}
                        value={task.key ?? ""}
                        onChange={(e) => {
                          const tasks = [...editing!.tasksTemplate];
                          tasks[taskIndex] = {
                            ...task,
                            key: e.target.value || undefined,
                          };
                          setEditing({ ...editing!, tasksTemplate: tasks });
                        }}
                        placeholder={`task_${taskIndex + 1}`}
                        className="mt-1 block w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div className="col-span-4">
                      <label className="text-xs font-medium">Title *</label>
                      <input
                        type="text"
                        data-testid={`task-title-${taskIndex}`}
                        value={task.title}
                        onChange={(e) => {
                          const tasks = [...editing!.tasksTemplate];
                          tasks[taskIndex] = { ...task, title: e.target.value };
                          setEditing({ ...editing!, tasksTemplate: tasks });
                        }}
                        placeholder="Build"
                        className="mt-1 block w-full rounded border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="text-xs font-medium">Description</label>
                      <input
                        type="text"
                        data-testid={`task-description-${taskIndex}`}
                        value={task.description ?? ""}
                        onChange={(e) => {
                          const tasks = [...editing!.tasksTemplate];
                          tasks[taskIndex] = {
                            ...task,
                            description: e.target.value || undefined,
                          };
                          setEditing({ ...editing!, tasksTemplate: tasks });
                        }}
                        placeholder="(optional)"
                        className="mt-1 block w-full rounded border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs font-medium">Est. Minutes</label>
                      <input
                        type="number"
                        min={1}
                        data-testid={`task-minutes-${taskIndex}`}
                        value={task.estimatedMinutes ?? ""}
                        onChange={(e) => {
                          const tasks = [...editing!.tasksTemplate];
                          tasks[taskIndex] = {
                            ...task,
                            estimatedMinutes: parseInt(e.target.value, 10) || undefined,
                          };
                          setEditing({ ...editing!, tasksTemplate: tasks });
                        }}
                        placeholder="--"
                        className="mt-1 block w-full rounded border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div className="col-span-1 flex items-center justify-center pb-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditing({
                            ...editing!,
                            tasksTemplate: editing!.tasksTemplate.filter((_, i) => i !== taskIndex),
                          })
                        }
                        data-testid={`task-remove-${taskIndex}`}
                      >
                        ✕
                      </Button>
                    </div>
                  </div>
                ))}
                {editing!.tasksTemplate.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No task templates. Add tasks to define what gets created when this template is
                    applied.
                  </p>
                )}
              </div>
            </div>

            {/* Workflow section */}
            <div className="border-t border-border pt-4" data-testid="workflow-section">
              {editing!.workflowTemplate ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold">Workflow Definition</h4>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing({ ...editing!, workflowTemplate: null })}
                      data-testid="remove-workflow"
                    >
                      Remove Workflow
                    </Button>
                  </div>
                  <WorkflowTemplateEditor
                    tasks={editing!.tasksTemplate}
                    value={editing!.workflowTemplate}
                    onChange={(next) => setEditing({ ...editing!, workflowTemplate: next })}
                  />
                </div>
              ) : (
                <div>
                  <p className="mb-2 text-sm text-muted-foreground">
                    No workflow attached. Tasks will be created independently with no gate
                    dependencies.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        ...editing!,
                        workflowTemplate: { ...EMPTY_WORKFLOW },
                      })
                    }
                    disabled={editing!.tasksTemplate.length < 2}
                    data-testid="add-workflow"
                  >
                    + Add Workflow
                  </Button>
                  {editing!.tasksTemplate.length < 2 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      At least 2 task templates are required to define a workflow.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
      <DialogFooter>
        {showForm ? (
          <>
            <Button variant="ghost" onClick={cancelEdit} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saveMutation.isPending}>
              {editing?.id ? "Update" : "Create"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Done</Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
