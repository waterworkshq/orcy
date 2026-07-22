import React, { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  taskPublicationsApi,
  parsePublishTaskResponse,
  readAssignmentFailure,
} from "../../api/domains/taskPublications.js";
import { ApiError } from "../../api/transport.js";
import { useAgents, useTemplates, useCreateTaskInMission } from "../../lib/useHabitatData.js";
import {
  invalidateHabitatRepresentations,
  invalidateMissionRepresentations,
} from "../../lib/habitatMutations.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import type {
  TaskAssignmentWarningView,
  TaskPublicationErrorView,
  TaskPublicationOutcomeView,
} from "../../types/index.js";
import type { TaskPriority } from "../../types/index.js";

/** Props for the CreateTaskForm dialog. */
interface CreateTaskFormProps {
  open: boolean;
  onClose: () => void;
  habitatId?: string;
  missionId?: string;
}

/**
 * Polling interval (ms) for the 202 + `recovering:true` recovery surface.
 * The dispatcher (T4A) + assignment coordinator (T5) advance the attempt
 * past `published_pending_observation` / `published_pending_assignment`
 * within the configured deadline (default assignment deadline lives in
 * `ORCY_ASSIGNMENT_DEADLINE_MS`); a 1500ms cadence keeps the UX responsive
 * without hammering the GET endpoint.
 */
const POLL_INTERVAL_MS = 1500;

/** Attempt-key polling cap (ms) for one UI observation window. This is shorter
 *  than the server assignment deadline; expiry leaves the attempt recoverable
 *  and offers an explicit refresh instead of treating it as failed. */
const POLL_TIMEOUT_MS = 60_000;

/** Generate a client-side UUID. Uses `crypto.randomUUID()` when available
 *  (modern browsers + Node 19+); falls back to a Math.random-based v4 UUID
 *  for older environments (test jsdom). The attempt key only needs to be
 *  unique per (auditSource, targetMissionId) scope; uniqueness + entropy
 *  are the only constraints. */
function generateAttemptKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // jsdom fallback — sufficient for client identity; the kernel's reservation
  // is the source of truth for collision rejection.
  return "00000000-0000-4000-8000-000000000000".replace(/[018]/g, (c) => {
    const r = Math.random() * 16;
    const v = c === "0" ? r : (r & 0x3) | 0x8;
    return Math.floor(v).toString(16);
  });
}

/**
 * Dialog form for creating a new task (T11 Phase 2 — publication attempt-
 * key lifecycle). Supports templates, priority, labels, required domain,
 * due date, and SLA. Resets on open/close.
 *
 * The form attempts `POST /missions/:missionId/task-publications` first and
 * falls back to the legacy `POST /missions/:missionId/tasks` on HTTP 404
 * (the cutover flag is off, the route is not registered). See
 * `packages/ui/src/api/domains/taskPublications.ts` for the flag-detection
 * rationale.
 */
export function CreateTaskForm({ open, onClose, habitatId, missionId }: CreateTaskFormProps) {
  const qc = useQueryClient();
  const { data: templatesData } = useTemplates(habitatId);
  const templates = templatesData?.templates ?? [];
  const { data: agents = [] } = useAgents();
  // The legacy fallback reuses `useCreateTaskInMission` so its invalidation
  // hooks (mission task lists + habitat/mission representations) fire on
  // success — same surface the new path invalidates manually below.
  const createTaskMutation = useCreateTaskInMission(missionId ?? "");

  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [requiredDomain, setRequiredDomain] = useState("");
  const [requiredCapabilities, setRequiredCapabilities] = useState<string[]>([]);
  const [capabilityInput, setCapabilityInput] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");

  // --- Publication attempt-key lifecycle -----------------------------------
  // `attemptKey` is generated on the FIRST Publish press and RETAINED across
  // repeated clicks / timeouts / status polls. Same-key + same-fingerprint
  // is an idempotent replay (server returns `replayed`); same-key +
  // different-fingerprint is a deterministic rejection
  // (`rejected_fingerprint`, the user must pick a new key).
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<TaskPublicationOutcomeView | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    readonly TaskPublicationErrorView[] | null
  >(null);
  const [polling, setPolling] = useState(false);
  const [stillSettlingAttemptId, setStillSettlingAttemptId] = useState<string | null>(null);
  const [assignmentWarning, setAssignmentWarning] = useState<TaskAssignmentWarningView | null>(null);
  const [retryAgentId, setRetryAgentId] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Polling bookkeeping — held in refs so the interval closure stays fresh
  // without re-running the effect on every state tick.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadlineRef = useRef<number | null>(null);

  function stopPolling() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollDeadlineRef.current = null;
  }

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
      setAttemptKey(null);
      setOutcome(null);
      setValidationErrors(null);
      setPolling(false);
      setStillSettlingAttemptId(null);
      setAssignmentWarning(null);
      setRetryAgentId("");
      setSubmitError(null);
      stopPolling();
    }
  }, [open]);

  // Tear down any active poll when the dialog closes or unmounts.
  useEffect(() => {
    return () => stopPolling();
  }, []);

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

  function recordTemplateUsage(templateId: string | undefined) {
    if (templateId) {
      api.templates.recordUsage(templateId).catch(() => {});
    }
  }

  function resetForm() {
    setTitle("");
    setDescription("");
    setPriority("medium");
    setRequiredDomain("");
    setRequiredCapabilities([]);
    setCapabilityInput("");
    setEstimatedMinutes("");
    setSelectedTemplateId("");
    setAttemptKey(null);
    setOutcome(null);
    setValidationErrors(null);
    setPolling(false);
    setStillSettlingAttemptId(null);
    setAssignmentWarning(null);
    setRetryAgentId("");
    setSubmitError(null);
    stopPolling();
  }

  function invalidateAfterSuccess() {
    if (!missionId) return;
    qc.invalidateQueries({ queryKey: queryKeys.missions.tasks(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.details(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.progress(missionId) });
    invalidateMissionRepresentations(qc, missionId);
    if (habitatId) {
      invalidateHabitatRepresentations(qc, habitatId);
    }
  }

  function closeOnSuccess(label: string) {
    recordTemplateUsage(selectedTemplateId);
    notify.success(`Task "${label}" created`);
    resetForm();
    onClose();
  }

  function showAssignmentWarning(warning: TaskAssignmentWarningView) {
    stopPolling();
    setPolling(false);
    setStillSettlingAttemptId(null);
    setAssignmentWarning(warning);
    invalidateAfterSuccess();
    recordTemplateUsage(selectedTemplateId);
    notify.success(`Task "${title.trim()}" created, but assignment needs attention`);
  }

  async function retryAssignment() {
    if (!assignmentWarning || !retryAgentId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await taskPublicationsApi.retryAssignment(
        assignmentWarning.taskId,
        retryAgentId,
      );
      invalidateAfterSuccess();
      notify.success(
        result.outcome === "assigned"
          ? `Task "${title.trim()}" assigned`
          : `Task "${title.trim()}" is already assigned`,
      );
      resetForm();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to retry assignment";
      setSubmitError(message);
      notify.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Walk the typed outcome after a 2xx publish response.
   *
   * The view-model's `outcome` discriminator covers:
   *   - `"created"` + `recovering:true` → 202; commit a poll cycle.
   *   - `"created"` terminal             → 201; close on success.
   *   - `"replayed"`                     → 200; surface the stored terminal
   *     verbatim — narrow on the wrapped `taskId` field.
   *   - `"rejected_validation"`          → 422; render per-field errors.
   *   - `"vetoed"` → 403; `"rejected_fingerprint"` → 409; render refusal.
   *   - `"guard_mismatch"` / `"governance_denied"` → 503; the attempt is
   *     resumable under the same key, but for an interactive dialog we
   *     surface the refusal and let the user retry manually.
   */
  function handlePublicationOutcome(parsed: TaskPublicationOutcomeView) {
    switch (parsed.outcome) {
      case "created": {
        if ("recovering" in parsed && parsed.recovering) {
          // 202 path — start polling. The committed task id is captured in
          // `parsed.taskId`; the poll resolves the terminal state.
          setOutcome(parsed);
          setStillSettlingAttemptId(null);
          setAssignmentWarning(null);
          setPolling(true);
          pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
          schedulePoll(parsed.attemptId, parsed.taskId);
          return;
        }
        // 201 terminal — close on success.
        const label = title.trim();
        invalidateAfterSuccess();
        closeOnSuccess(label);
        return;
      }
      case "replayed": {
        // An idempotent retry hit a terminal attempt. The stored terminal
        // fields arrive verbatim (taskId, errors, veto — forwarded by the
        // HTTP mapper's `...terminalRest` spread). Close on success when a
        // Task committed; otherwise surface the stored terminal so the user
        // can see WHY the stored attempt failed.
        if (parsed.taskId && parsed.assignmentFailure) {
          setOutcome(parsed);
          showAssignmentWarning({ taskId: parsed.taskId, failure: parsed.assignmentFailure });
          return;
        }
        if (parsed.taskId) {
          const label = title.trim();
          invalidateAfterSuccess();
          closeOnSuccess(label);
          return;
        }
        // The stored terminal was a failure — surface its fields verbatim.
        // The attempt key is terminal; null it so the next submit generates
        // a fresh key (a corrected payload under the old key would collide
        // with the stored terminal fingerprint).
        if (parsed.errors) {
          setValidationErrors(parsed.errors);
        } else if (parsed.veto) {
          setSubmitError(
            `Governance refused the task: ${parsed.veto.interceptorKey} — ${parsed.veto.reason}`,
          );
        } else {
          setSubmitError("Replayed attempt has no committed Task. Please retry with a new key.");
        }
        setAttemptKey(null);
        setOutcome(parsed);
        return;
      }
      case "rejected_validation": {
        setValidationErrors(parsed.errors);
        setAttemptKey(null);
        setOutcome(parsed);
        return;
      }
      case "vetoed": {
        setSubmitError(
          `Governance refused the task: ${parsed.veto.interceptorKey} — ${parsed.veto.reason}`,
        );
        // The attempt is terminal — a retry needs a fresh key so a corrected
        // payload doesn't collide with the stored terminal fingerprint.
        setAttemptKey(null);
        setOutcome(parsed);
        return;
      }
      case "rejected_fingerprint": {
        // The user must pick a new attempt key — the stored payload under
        // the same key is different from the submitted one.
        setAttemptKey(null);
        setSubmitError(parsed.message);
        setOutcome(parsed);
        return;
      }
      case "guard_mismatch":
      case "governance_denied": {
        setSubmitError(
          parsed.outcome === "guard_mismatch"
            ? "Guard drift detected — please retry."
            : `Governance denied: ${parsed.reason}`,
        );
        setOutcome(parsed);
        return;
      }
    }
  }

  function schedulePoll(attemptId: string, _committedTaskId: string) {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => void runPoll(attemptId), POLL_INTERVAL_MS);
  }

  async function runPoll(attemptId: string) {
    if (pollDeadlineRef.current !== null && Date.now() > pollDeadlineRef.current) {
      stopPolling();
      setPolling(false);
      setStillSettlingAttemptId(attemptId);
      return;
    }
    try {
      const status = await taskPublicationsApi.getTaskCreationAttempt(attemptId);
      if (status.state === "created_unassigned") {
        const failure = readAssignmentFailure(status) ?? {
          reason: status.terminalOutcome ?? "assignment_failed",
        };
        const taskId = status.committedTaskId;
        if (!taskId) {
          stopPolling();
          setPolling(false);
          setSubmitError("Task committed without an assignment, but its task id is unavailable.");
          return;
        }
        showAssignmentWarning({ taskId, failure });
        return;
      }
      if (status.state === "created") {
        stopPolling();
        setPolling(false);
        const label = title.trim();
        invalidateAfterSuccess();
        closeOnSuccess(label);
        return;
      }
      if (
        status.state === "rejected_validation" ||
        status.state === "vetoed" ||
        status.state === "batch_rejected"
      ) {
        stopPolling();
        setPolling(false);
        setAttemptKey(null);
        setSubmitError(
          status.state === "vetoed"
            ? "Governance refused the task during recovery."
            : `Publication failed: ${status.state}`,
        );
        return;
      }
      // Still non-terminal — keep polling.
      schedulePoll(attemptId, status.committedTaskId ?? "");
    } catch (err) {
      stopPolling();
      setPolling(false);
      const message = err instanceof Error ? err.message : "Failed to check publication status";
      setSubmitError(message);
      notify.error(message);
    }
  }

  function refreshPublicationStatus() {
    if (!stillSettlingAttemptId) return;
    const attemptId = stillSettlingAttemptId;
    setStillSettlingAttemptId(null);
    setPolling(true);
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    void runPoll(attemptId);
  }

  async function publishViaNewRoute(key: string) {
    const result = await taskPublicationsApi.publishTask(missionId ?? "", {
      attemptKey: key,
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      requiredDomain: requiredDomain.trim() || undefined,
      requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      estimatedMinutes: estimatedMinutes ? parseInt(estimatedMinutes, 10) : undefined,
    });
    // 2xx — narrow the body through the typed dispatch parser. The HTTP
    // mapper always emits a closed-union body on success, but we route
    // through the type guard so a structural drift surfaces as a generic
    // error rather than a typed wrong-render.
    const parsed = parsePublishTaskResponse(200, result);
    if (parsed.kind === "outcome") {
      handlePublicationOutcome(parsed.outcome);
      return;
    }
    setSubmitError(parsed.body.error ?? "Unexpected response from publication route");
  }

  async function publishViaLegacyFallback() {
    const result = await createTaskMutation.mutateAsync({
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      requiredDomain: requiredDomain.trim() || undefined,
      requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      estimatedMinutes: estimatedMinutes ? parseInt(estimatedMinutes, 10) : undefined,
    });
    recordTemplateUsage(selectedTemplateId);
    notify.success(`Task "${title.trim()}" created`);
    resetForm();
    onClose();
    return result;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !missionId) return;

    // Reset transient state so a retry after a previous rejection doesn't
    // show stale errors.
    setSubmitError(null);
    setOutcome(null);
    setValidationErrors(null);
    setPolling(false);
    setStillSettlingAttemptId(null);
    setAssignmentWarning(null);
    setRetryAgentId("");
    stopPolling();

    const key = attemptKey ?? generateAttemptKey();
    setAttemptKey(key);
    setSubmitting(true);
    try {
      try {
        await publishViaNewRoute(key);
        return;
      } catch (err) {
        // The cutover flag is HTTP-404 detected — the route is not
        // registered while the flag is off. Fall back to the legacy
        // `POST /missions/:missionId/tasks` so the form keeps working.
        if (err instanceof ApiError && err.status === 404) {
          await publishViaLegacyFallback();
          return;
        }
        // Non-2xx with a structured body: recover the typed outcome so the
        // dialog renders the per-field errors / governance refusal rather
        // than a generic error message.
        if (err instanceof ApiError) {
          const recovered = (() => {
            const body = err.body;
            if (typeof body !== "object" || body === null) return null;
            const outcome = (body as { outcome?: unknown }).outcome;
            if (typeof outcome !== "string") return null;
            return body as TaskPublicationOutcomeView;
          })();
          if (recovered) {
            handlePublicationOutcome(recovered);
            return;
          }
        }
        // Generic failure — surface the message.
        const message = err instanceof Error ? err.message : "Failed to create task";
        setSubmitError(message);
        notify.error(message);
      }
    } finally {
      setSubmitting(false);
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

            {/* Per-field validation errors from the kernel's
                `rejected_validation` branch (422). The banner is amber —
                nothing was committed (the preflight is pure), the user can
                fix and retry. */}
            {validationErrors && validationErrors.length > 0 && (
              <div
                className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded text-sm"
                data-testid="validation-errors"
              >
                <div className="font-medium text-amber-900 dark:text-amber-100 mb-1">
                  Publication rejected — fix and retry
                </div>
                <ul className="text-xs space-y-1">
                  {validationErrors.map((e, i) => (
                    <li key={i}>
                      <code className="font-mono">{e.field}</code> ·{" "}
                      <code className="font-mono">{e.code}</code> · {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 202 + `recovering:true` poll banner. The committed task id is
                already known; we are waiting for the dispatcher / assignment
                coordinator to settle the attempt. */}
            {polling && (
              <div
                className="p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded text-sm"
                data-testid="polling-status"
              >
                <div className="font-medium text-blue-900 dark:text-blue-100">
                  Checking publication status…
                </div>
                <div className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                  The task committed but is still settling. This dialog will close when the
                  publication is fully observed.
                </div>
              </div>
            )}

            {stillSettlingAttemptId && (
              <div
                className="p-3 bg-muted border border-border rounded text-sm"
                data-testid="still-settling-status"
              >
                <div className="font-medium">Publication is still settling</div>
                <div className="mt-1 text-muted-foreground">
                  The committed attempt remains valid. You can check again without creating a new
                  task or changing the attempt key.
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={refreshPublicationStatus}
                  data-testid="refresh-publication-status"
                >
                  Check again
                </Button>
              </div>
            )}

            {assignmentWarning && (
              <div
                className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded text-sm"
                data-testid="assignment-warning"
              >
                <div className="font-medium text-amber-900 dark:text-amber-100">
                  Task created; assignment needs attention
                </div>
                <div className="mt-1 text-amber-800 dark:text-amber-200">
                  Assignment failed: {assignmentWarning.failure.reason}
                  {assignmentWarning.failure.category
                    ? ` (${assignmentWarning.failure.category})`
                    : ""}
                </div>
                <div className="mt-3 flex gap-2">
                  <select
                    value={retryAgentId}
                    onChange={(e) => setRetryAgentId(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
                    aria-label="Agent for assignment retry"
                  >
                    <option value="">Choose an agent</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void retryAssignment()}
                    loading={submitting}
                    disabled={submitting || !retryAgentId}
                    data-testid="retry-assignment"
                  >
                    Retry assignment
                  </Button>
                </div>
              </div>
            )}

            {/* Generic submit error — used for vetoes, fingerprint rejections,
                guard mismatches, and transport failures. */}
            {submitError && !validationErrors && (
              <div
                className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
                data-testid="submit-error"
              >
                {submitError}
              </div>
            )}
          </div>
        </DialogContent>

        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={submitting || polling}
            disabled={
              submitting ||
              polling ||
              !!stillSettlingAttemptId ||
              !!assignmentWarning ||
              !title.trim()
            }
          >
            Create Task
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
