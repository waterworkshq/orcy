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
import { useAgents } from "../../lib/useHabitatData.js";
import {
  invalidateHabitatRepresentations,
  invalidateMissionRepresentations,
} from "../../lib/habitatMutations.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import type {
  ClonePreparationView,
  ClonePreparationSubtaskView,
  TaskAssignmentWarningView,
  TaskPublicationErrorView,
  TaskPublicationOutcomeView,
} from "../../types/index.js";
import type { TaskPriority } from "../../types/index.js";

/** Props for the {@link CloneTaskForm} dialog. */
interface CloneTaskFormProps {
  open: boolean;
  onClose: () => void;
  sourceTask: { id: string; title: string };
  habitatId?: string;
}

/** Polling cadence + UI observation window for the 202 + `recovering:true`
 *  surface. The window is shorter than the server assignment deadline; expiry
 *  leaves the attempt recoverable and offers an explicit refresh. */
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

/** Generate a client-side UUID. Uses `crypto.randomUUID()` when available;
 *  falls back to a Math.random-based v4 UUID for older environments. */
function generateAttemptKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "00000000-0000-4000-8000-000000000000".replace(/[018]/g, (c) => {
    const r = Math.random() * 16;
    const v = c === "0" ? r : (r & 0x3) | 0x8;
    return Math.floor(v).toString(16);
  });
}

/**
 * Clone preparation + publication dialog (T11 Phase 2 — UI side).
 *
 * The clone is a prepare-edit-publish journey, NOT immediate Task creation
 * (Core Flows § "Editable Clone Preparation and Publication"). Opening this
 * dialog creates NOTHING — no attempt, no Task, no event. The dialog:
 *
 *   1. Fetches `GET /tasks/:sourceTaskId/clone-preparation` (a read-only
 *      allowlisted DTO) when it opens. The route is NOT gated behind the
 *      cutover flag (safe preparation surface).
 *   2. Prefills editable fields with the source's work-definition + RESET
 *      Subtasks + UNSELECTED dependency suggestions. The user may edit any
 *      field; subtasks can be added / removed / reordered.
 *   3. On Publish, calls `POST /tasks/:sourceTaskId/clone-publications` with
 *      the EDITED work-definition. The POST is gated behind the cutover
 *      flag; on HTTP 404 (flag off) the dialog falls back to the legacy
 *      `POST /tasks/:id/clone` (immediate copy, no edit step).
 *
 * The flag-detection strategy is HTTP-404 detection (mirrors
 * {@link CreateTaskForm} — see `packages/ui/src/api/domains/taskPublications.ts`
 * for the rationale).
 */
export function CloneTaskForm({ open, onClose, sourceTask, habitatId }: CloneTaskFormProps) {
  const qc = useQueryClient();
  const { data: agents = [] } = useAgents();

  // --- Preparation fetch state -------------------------------------------
  const [prepLoading, setPrepLoading] = useState(false);
  const [prep, setPrep] = useState<ClonePreparationView | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [prepUnavailable, setPrepUnavailable] = useState(false);

  // --- Editable fields (seeded from preparation DTO) ---------------------
  const [targetMissionId, setTargetMissionId] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [requiredDomain, setRequiredDomain] = useState<string>("");
  const [requiredCapabilities, setRequiredCapabilities] = useState<string[]>([]);
  const [estimatedMinutes, setEstimatedMinutes] = useState<string>("");
  const [subtasks, setSubtasks] = useState<ClonePreparationSubtaskView[]>([]);
  const [selectedDependencies, setSelectedDependencies] = useState<string[]>([]);

  // --- Publication attempt-key lifecycle ---------------------------------
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

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadlineRef = useRef<number | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  function stopPolling() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollDeadlineRef.current = null;
  }

  function resetDialog() {
    setPrep(null);
    setPrepError(null);
    setPrepUnavailable(false);
    setPrepLoading(false);
    setTargetMissionId("");
    setTitle("");
    setDescription("");
    setPriority("medium");
    setRequiredDomain("");
    setRequiredCapabilities([]);
    setEstimatedMinutes("");
    setSubtasks([]);
    setSelectedDependencies([]);
    setAttemptKey(null);
    setOutcome(null);
    setValidationErrors(null);
    setPolling(false);
    setStillSettlingAttemptId(null);
    setAssignmentWarning(null);
    setRetryAgentId("");
    setSubmitError(null);
    stopPolling();
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }
  }

  // Fetch the preparation when the dialog opens.
  useEffect(() => {
    if (!open) {
      resetDialog();
      return;
    }
    if (!sourceTask.id) return;

    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setPrepLoading(true);
    setPrep(null);
    setPrepError(null);
    setPrepUnavailable(false);
    setSubmitError(null);

    void (async () => {
      try {
        const result = await taskPublicationsApi.getClonePreparation(
          sourceTask.id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setPrep(result);
        // Seed editable fields from the prep DTO.
        setTargetMissionId(result.defaultTargetMissionId);
        setTitle(result.title);
        setDescription(result.description);
        setPriority(result.priority);
        setRequiredDomain(result.requiredDomain ?? "");
        setRequiredCapabilities([...result.requiredCapabilities]);
        setEstimatedMinutes(result.estimatedMinutes != null ? String(result.estimatedMinutes) : "");
        setSubtasks([...result.subtasks]);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) {
          // The route is not registered — the entire publication feature is
          // dormant. Surface as a "no preparation available" state and let
          // the user fall back to the legacy immediate clone.
          setPrepUnavailable(true);
        } else {
          const message = err instanceof Error ? err.message : "Failed to load clone preparation";
          setPrepError(message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setPrepLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
      stopPolling();
    };
    // We intentionally re-key on sourceTask.id + open so the fetch fires
    // each time the dialog opens against a different source Task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceTask.id]);

  function addSubtaskRow() {
    setSubtasks([...subtasks, { title: "", order: subtasks.length }]);
  }

  function updateSubtask(index: number, value: string) {
    const next = subtasks.slice();
    next[index] = { ...next[index], title: value };
    setSubtasks(next);
  }

  function removeSubtask(index: number) {
    const next = subtasks.slice();
    next.splice(index, 1);
    setSubtasks(next.map((s, i) => ({ ...s, order: i })));
  }

  function toggleDependency(depId: string) {
    setSelectedDependencies((prev) =>
      prev.includes(depId) ? prev.filter((d) => d !== depId) : [...prev, depId],
    );
  }

  function invalidateAfterSuccess(missionId: string) {
    qc.invalidateQueries({ queryKey: queryKeys.missions.tasks(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.details(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.progress(missionId) });
    invalidateMissionRepresentations(qc, missionId);
    if (habitatId) {
      invalidateHabitatRepresentations(qc, habitatId);
    }
  }

  function closeOnSuccess(label: string, missionId: string) {
    notify.success(`Task "${label}" cloned`);
    resetDialog();
    onClose();
    invalidateAfterSuccess(missionId);
  }

  function showAssignmentWarning(warning: TaskAssignmentWarningView) {
    stopPolling();
    setPolling(false);
    setStillSettlingAttemptId(null);
    setAssignmentWarning(warning);
    invalidateAfterSuccess(targetMissionId);
    notify.success(`Task "${title.trim() || "cloned task"}" cloned, but assignment needs attention`);
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
      invalidateAfterSuccess(targetMissionId);
      notify.success(
        result.outcome === "assigned"
          ? `Task "${title.trim() || "cloned task"}" assigned`
          : `Task "${title.trim() || "cloned task"}" is already assigned`,
      );
      resetDialog();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to retry assignment";
      setSubmitError(message);
      notify.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  function schedulePoll(attemptId: string) {
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
          setSubmitError("Cloned task committed without an assignment, but its task id is unavailable.");
          return;
        }
        showAssignmentWarning({ taskId, failure });
        return;
      }
      if (status.state === "created") {
        stopPolling();
        setPolling(false);
        closeOnSuccess(title.trim() || "cloned task", targetMissionId);
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
            ? "Governance refused the clone during recovery."
            : `Clone failed: ${status.state}`,
        );
        return;
      }
      // Still non-terminal — keep polling.
      schedulePoll(attemptId);
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

  function handlePublicationOutcome(parsed: TaskPublicationOutcomeView, finalMissionId: string) {
    switch (parsed.outcome) {
      case "created": {
        if ("recovering" in parsed && parsed.recovering) {
          setOutcome(parsed);
          setStillSettlingAttemptId(null);
          setAssignmentWarning(null);
          setPolling(true);
          pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
          schedulePoll(parsed.attemptId);
          return;
        }
        closeOnSuccess(title.trim() || "cloned task", finalMissionId);
        return;
      }
      case "replayed": {
        if (parsed.taskId && parsed.assignmentFailure) {
          setOutcome(parsed);
          showAssignmentWarning({ taskId: parsed.taskId, failure: parsed.assignmentFailure });
          return;
        }
        if (parsed.taskId) {
          closeOnSuccess(title.trim() || "cloned task", finalMissionId);
          return;
        }
        // The stored terminal was a failure — surface its fields verbatim
        // (the HTTP mapper forwards them via `...terminalRest`). The attempt
        // key is terminal; null it so the next submit generates a fresh key.
        if (parsed.errors) {
          setValidationErrors(parsed.errors);
        } else if (parsed.veto) {
          setSubmitError(
            `Governance refused the clone: ${parsed.veto.interceptorKey} — ${parsed.veto.reason}`,
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
          `Governance refused the clone: ${parsed.veto.interceptorKey} — ${parsed.veto.reason}`,
        );
        // The attempt is terminal — a retry needs a fresh key so a corrected
        // payload doesn't collide with the stored terminal fingerprint.
        setAttemptKey(null);
        setOutcome(parsed);
        return;
      }
      case "rejected_fingerprint": {
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

  async function publishCloneViaNewRoute(key: string) {
    if (!targetMissionId) {
      setSubmitError("Target mission is required.");
      return;
    }
    const result = await taskPublicationsApi.publishClone(sourceTask.id, {
      attemptKey: key,
      targetMissionId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      requiredDomain: requiredDomain.trim() || undefined,
      requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      estimatedMinutes: estimatedMinutes ? parseInt(estimatedMinutes, 10) : undefined,
      subtasks: subtasks
        .filter((s) => s.title.trim().length > 0)
        .map((s, i) => ({ title: s.title.trim(), order: i })),
      selectedDependencies: selectedDependencies.length > 0 ? selectedDependencies : undefined,
    });
    const parsed = parsePublishTaskResponse(200, result);
    if (parsed.kind === "outcome") {
      handlePublicationOutcome(parsed.outcome, targetMissionId);
      return;
    }
    setSubmitError(parsed.body.error ?? "Unexpected response from clone publication route");
  }

  async function fallbackToLegacyClone() {
    // The cutover flag is off → fall back to the immediate-copy legacy
    // `POST /tasks/:id/clone`. This bypasses the edit step (the user
    // cannot edit before clone when the flag is off).
    try {
      await api.tasks.clone(sourceTask.id);
      notify.success("Task cloned");
      resetDialog();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clone task";
      setSubmitError(message);
      notify.error(message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
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
        await publishCloneViaNewRoute(key);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Flag-off fallback — the POST publication route is gated and
          // 404s when the cutover flag is off. Fire the legacy immediate
          // clone so the user still gets a working feature.
          await fallbackToLegacyClone();
          return;
        }
        if (err instanceof ApiError) {
          const body = err.body;
          if (typeof body === "object" && body !== null && "outcome" in body) {
            handlePublicationOutcome(body as TaskPublicationOutcomeView, targetMissionId);
            return;
          }
        }
        const message = err instanceof Error ? err.message : "Failed to clone task";
        setSubmitError(message);
        notify.error(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLegacyCloneOnly() {
    setSubmitting(true);
    try {
      await fallbackToLegacyClone();
    } finally {
      setSubmitting(false);
    }
  }

  const sourceRef = prep?.source;
  const isLoading = prepLoading;
  const hasFetched = prep !== null || prepUnavailable || prepError !== null;

  return (
    <Dialog open={open} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>Clone task</DialogTitle>
          <DialogDescription>
            Create a new task from <strong>{sourceTask.title}</strong>. Edit any field before
            publishing — copied Subtasks reset to incomplete and unassigned.
          </DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="space-y-4">
            {isLoading && (
              <div className="p-3 bg-muted rounded text-sm" data-testid="prep-loading">
                Loading clone preparation…
              </div>
            )}

            {prepUnavailable && !isLoading && (
              <div
                className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded text-sm"
                data-testid="prep-unavailable"
              >
                <div className="font-medium text-amber-900 dark:text-amber-100">
                  Clone preparation is unavailable
                </div>
                <div className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                  The clone publication feature is dormant on this server. The dialog below falls
                  back to the legacy immediate-copy path.
                </div>
              </div>
            )}

            {prepError && !prepUnavailable && !isLoading && (
              <div
                className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
                data-testid="prep-error"
              >
                {prepError}
              </div>
            )}

            {(prep !== null || prepUnavailable) && !isLoading && (
              <>
                {sourceRef && (
                  <div className="p-3 bg-muted rounded text-xs">
                    <div className="font-medium">Source</div>
                    <div className="text-muted-foreground">
                      task <code className="font-mono">{sourceRef.taskId}</code> · mission{" "}
                      <code className="font-mono">{sourceRef.missionId}</code>
                      {sourceRef.habitatId ? ` · habitat ${sourceRef.habitatId}` : ""}
                    </div>
                  </div>
                )}

                <div>
                  <label className="mb-1 block text-sm font-medium">Target mission *</label>
                  <input
                    type="text"
                    value={targetMissionId}
                    onChange={(e) => setTargetMissionId(e.target.value)}
                    placeholder="Mission id"
                    required
                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Defaults to the source's Mission. Use another active Mission in the same
                    Habitat.
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium">Title *</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Task title"
                    required
                    maxLength={500}
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
                  <label className="mb-1 block text-sm font-medium">
                    Subtasks ({subtasks.length})
                  </label>
                  <div className="space-y-2">
                    {subtasks.map((s, i) => (
                      <div key={i} className="flex gap-2">
                        <input
                          type="text"
                          value={s.title}
                          onChange={(e) => updateSubtask(i, e.target.value)}
                          placeholder={`Subtask ${i + 1}`}
                          className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeSubtask(i)}
                          aria-label={`Remove subtask ${i + 1}`}
                        >
                          ×
                        </Button>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" onClick={addSubtaskRow}>
                      + Add subtask
                    </Button>
                  </div>
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

                {(prep?.dependencySuggestions?.length ?? 0) > 0 && (
                  <div data-testid="dependency-suggestions">
                    <label className="mb-1 block text-sm font-medium">
                      Suggested dependencies ({prep!.dependencySuggestions.length})
                    </label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Optional tasks the clone should depend on. Select the ones to include.
                    </p>
                    <div className="space-y-1">
                      {prep!.dependencySuggestions.map((dep) => (
                        <label key={dep.dependsOnId} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={selectedDependencies.includes(dep.dependsOnId)}
                            onChange={() => toggleDependency(dep.dependsOnId)}
                            className="rounded"
                          />
                          <code className="font-mono">{dep.dependsOnId}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Per-field validation errors from the kernel's
                    `rejected_validation` branch (422). */}
                {validationErrors && validationErrors.length > 0 && (
                  <div
                    className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded text-sm"
                    data-testid="validation-errors"
                  >
                    <div className="font-medium text-amber-900 dark:text-amber-100 mb-1">
                      Clone rejected — fix and retry
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

                {/* 202 + `recovering:true` poll banner. */}
                {polling && (
                  <div
                    className="p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded text-sm"
                    data-testid="polling-status"
                  >
                    <div className="font-medium text-blue-900 dark:text-blue-100">
                      Checking publication status…
                    </div>
                    <div className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                      The cloned task committed but is still settling. This dialog will close when
                      the publication is fully observed.
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
                      The committed clone attempt remains valid. You can check again without
                      creating another task or changing the attempt key.
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
                      Task cloned; assignment needs attention
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

                {/* Generic submit error. */}
                {submitError && !validationErrors && (
                  <div
                    className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
                    data-testid="submit-error"
                  >
                    {submitError}
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>

        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {prepUnavailable ? (
            <Button
              type="button"
              onClick={() => void handleLegacyCloneOnly()}
              loading={submitting}
              disabled={submitting}
              data-testid="legacy-clone-btn"
            >
              Clone directly
            </Button>
          ) : (
            <Button
              type="submit"
              loading={submitting || polling}
              disabled={
                submitting ||
                polling ||
                !!stillSettlingAttemptId ||
                !!assignmentWarning ||
                !title.trim() ||
                !targetMissionId ||
                !hasFetched
              }
            >
              Publish clone
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
