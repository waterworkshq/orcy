import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { RichTextEditor } from "../ui/RichTextEditor.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { useTemplates, useCreateTaskInMission } from "../../lib/useHabitatData.js";
import type { TaskPriority } from "../../types/index.js";

/** Props for the CreateTaskForm dialog. */
interface CreateTaskFormProps {
  open: boolean;
  onClose: () => void;
  habitatId?: string;
  missionId?: string;
}

/**
 * Dialog form for creating a new task. Supports templates, priority,
 * labels, required domain, due date, and SLA. Resets on open/close.
 */
export function CreateTaskForm({ open, onClose, habitatId, missionId }: CreateTaskFormProps) {
  const { data: templatesData } = useTemplates(habitatId);
  const templates = templatesData?.templates ?? [];
  const createTaskMutation = useCreateTaskInMission(missionId ?? "");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [requiredDomain, setRequiredDomain] = useState("");
  const [requiredCapabilities, setRequiredCapabilities] = useState<string[]>([]);
  const [capabilityInput, setCapabilityInput] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedTemplateId("");
      setTitle("");
      setDescription("");
      setPriority("medium");
      setRequiredDomain("");
      setRequiredCapabilities([]);
      setCapabilityInput("");
      setEstimatedMinutes("");
    }
  }, [open]);

  function handleTemplateChange(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) {
      setTitle("");
      setDescription("");
      setPriority("medium");
      setRequiredDomain("");
      setRequiredCapabilities([]);
      setCapabilityInput("");
      return;
    }
    const tmpl = templates.find((t) => t.id === templateId);
    if (tmpl) {
      setTitle(tmpl.titlePattern);
      setDescription(tmpl.descriptionPattern);
      setPriority(tmpl.priority);
      setRequiredDomain(tmpl.requiredDomain ?? "");
      setRequiredCapabilities(tmpl.requiredCapabilities ?? []);
    }
  }

  function addCapability(value: string) {
    const trimmed = value.trim();
    if (trimmed && !requiredCapabilities.includes(trimmed)) {
      setRequiredCapabilities([...requiredCapabilities, trimmed]);
    }
    setCapabilityInput("");
  }

  function removeCapability(cap: string) {
    setRequiredCapabilities(requiredCapabilities.filter((c) => c !== cap));
  }

  function handleCapabilityKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addCapability(capabilityInput);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !missionId) return;

    try {
      const result = await createTaskMutation.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        requiredDomain: requiredDomain.trim() || undefined,
        requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
        estimatedMinutes: estimatedMinutes ? parseInt(estimatedMinutes, 10) : undefined,
      });
      if (selectedTemplateId) {
        api.templates.recordUsage(selectedTemplateId).catch(() => {});
      }

      notify.success(`Task "${title.trim()}" created`);
      setTitle("");
      setDescription("");
      setPriority("medium");
      setRequiredDomain("");
      setRequiredCapabilities([]);
      setCapabilityInput("");
      setEstimatedMinutes("");
      setSelectedTemplateId("");
      onClose();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>Add a new task to this board.</DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="space-y-4">
            {templates.length > 0 && (
              <div>
                <label className="mb-1 block text-sm font-medium">Template</label>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => handleTemplateChange(e.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Pick a template (optional)</option>
                  {templates.map((tmpl) => (
                    <option key={tmpl.id} value={tmpl.id}>
                      {tmpl.name} {tmpl.habitatId ? "(board)" : "(global)"}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium">Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
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
                placeholder="Task description (supports rich text formatting)"
                minHeight="120px"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

              <div>
                <label className="mb-1 block text-sm font-medium">Required Domain</label>
                <select
                  value={requiredDomain}
                  onChange={(e) => setRequiredDomain(e.target.value)}
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

            <div>
              <label className="mb-1 block text-sm font-medium">Required Capabilities</label>
              <div className="flex flex-wrap gap-1 mb-2">
                {requiredCapabilities.map((cap) => (
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
              <input
                type="text"
                value={capabilityInput}
                onChange={(e) => setCapabilityInput(e.target.value)}
                onKeyDown={handleCapabilityKeyDown}
                onBlur={() => {
                  if (capabilityInput.trim()) addCapability(capabilityInput);
                }}
                placeholder="e.g., typescript, react, python, node.js"
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Estimated Minutes</label>
              <input
                type="number"
                min="1"
                placeholder="e.g., 60"
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
        </DialogContent>

        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={createTaskMutation.isPending}
            disabled={createTaskMutation.isPending || !title.trim()}
          >
            Create Task
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
