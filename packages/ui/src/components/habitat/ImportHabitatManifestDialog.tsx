import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import {
  importsApi,
  parseImportApiError,
  parsePublishImportResponse,
  type LegacyImportResponse,
} from "../../api/domains/imports.js";
import { ApiError } from "../../api/transport.js";
import {
  IMPORT_MANIFEST_DOMAIN_NAMES as DOMAIN_NAMES,
  type ImportDisposition,
  type ImportManifestDomainName,
  type ImportOutcomeView,
  type ImportRejectionDetail,
  type ImportVetoView,
} from "../../types/index.js";
import { notify } from "../../lib/toast.js";

interface ImportHabitatManifestDialogProps {
  /** Replacement target habitat id. Omitted for "new habitat" imports. */
  habitatId?: string;
  boardName?: string;
  open: boolean;
  onClose: () => void;
  /** Invoked with the imported habitat id and the resolved mode on success. */
  onImport: (habitatId: string, mode: "new" | "replacement") => void;
}

const DOMAIN_LABELS: Record<ImportManifestDomainName, string> = {
  habitatSettings: "Habitat settings",
  columns: "Columns",
  missions: "Missions",
  tasks: "Tasks",
  subtasks: "Subtasks",
  dependencies: "Dependencies",
  comments: "Comments",
  templates: "Templates",
};

const DISPOSITION_LABELS: Record<ImportDisposition, string> = {
  replace: "Replace",
  preserve: "Preserve",
  reset: "Reset",
};

const DISPOSITION_DESCRIPTIONS: Record<ImportDisposition, string> = {
  replace: "Import's content overwrites target",
  preserve: "Target's content is kept; import adds additively",
  reset: "Clear target's content; import carries none",
};

/** Detect manifest version from the parsed JSON shape. */
function detectVersion(parsed: unknown): 1 | 2 | 3 | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = (parsed as { version?: unknown }).version;
  if (v === 1 || v === 2 || v === 3) return v;
  return null;
}

/** Read a v3 manifest's declared disposition for a given domain, defaulting
 *  to "preserve" for undeclared domains (omitted = preserve by default per
 *  `services/importManifest/types.ts`). */
function readDisposition(
  parsed: unknown,
  domain: ImportManifestDomainName,
): ImportDisposition {
  if (typeof parsed !== "object" || parsed === null) return "preserve";
  const domains = (parsed as { domains?: unknown }).domains;
  if (typeof domains !== "object" || domains === null) return "preserve";
  const envelope = (domains as Record<string, unknown>)[domain];
  if (typeof envelope !== "object" || envelope === null) return "preserve";
  const disp = (envelope as { disposition?: unknown }).disposition;
  if (disp === "replace" || disp === "preserve" || disp === "reset") return disp;
  return "preserve";
}

/** Read a v3 manifest's declared mode (or fall back to a default). */
function readMode(parsed: unknown): "new" | "replacement" | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = (parsed as { mode?: unknown }).mode;
  if (m === "new" || m === "replacement") return m;
  return null;
}

/** Read a v3 manifest's declared identityPolicy (or fall back to "remap"). */
function readIdentityPolicy(parsed: unknown): "remap" | "restore" {
  if (typeof parsed !== "object" || parsed === null) return "remap";
  const ip = (parsed as { identityPolicy?: unknown }).identityPolicy;
  if (ip === "restore") return "restore";
  return "remap";
}

/** Read a v3 manifest's `manifestId` (the attempt-key / reservation id). */
function readManifestId(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const id = (parsed as { manifestId?: unknown }).manifestId;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

/** Group preflight errors by their leading domain segment (parsed from
 *  `field`). Bare fields without a recognized domain fall into the
 *  `unscoped` bucket. See M3.1 grounding correction for the field-prefix
 *  convention (kernel's PublicationError has NO `domain` field). */
function groupErrorsByDomain(errors: readonly ImportRejectionDetail[]): {
  ungrouped: ImportRejectionDetail[];
  byDomain: Record<ImportManifestDomainName, ImportRejectionDetail[]>;
} {
  const byDomain = {} as Record<ImportManifestDomainName, ImportRejectionDetail[]>;
  for (const name of DOMAIN_NAMES) byDomain[name] = [];
  const ungrouped: ImportRejectionDetail[] = [];

  for (const err of errors) {
    const leading = err.field.split(".")[0];
    if (leading && (DOMAIN_NAMES as readonly string[]).includes(leading)) {
      byDomain[leading as ImportManifestDomainName].push(err);
    } else {
      ungrouped.push(err);
    }
  }
  return { ungrouped, byDomain };
}

export function ImportHabitatManifestDialog({
  habitatId,
  boardName: _boardName,
  open,
  onClose,
  onImport,
}: ImportHabitatManifestDialogProps) {
  // --- Submission config ---------------------------------------------------
  // Replacement mode is forced when a habitatId is provided; "new" mode is
  // the only option for the new-habitat route. UI surface pre-disables
  // the radio to communicate the constraint.
  const initialMode: "new" | "replacement" = habitatId ? "replacement" : "new";
  const [mode, setMode] = useState<"new" | "replacement">(initialMode);
  const [identityPolicy, setIdentityPolicy] = useState<"remap" | "restore">("remap");
  const [dispositions, setDispositions] = useState<
    Record<ImportManifestDomainName, ImportDisposition>
  >(() => {
    const init = {} as Record<ImportManifestDomainName, ImportDisposition>;
    for (const d of DOMAIN_NAMES) init[d] = "preserve";
    return init;
  });

  // --- Parsed manifest + version ------------------------------------------
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<unknown>(null);
  const [version, setVersion] = useState<1 | 2 | 3 | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // --- Submission state ---------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [v3Outcome, setV3Outcome] = useState<ImportOutcomeView | null>(null);
  const [legacyOutcome, setLegacyOutcome] = useState<LegacyImportResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Reset on open ------------------------------------------------------
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setIdentityPolicy("remap");
      setDispositions((prev) => {
        const next = {} as Record<ImportManifestDomainName, ImportDisposition>;
        for (const d of DOMAIN_NAMES) next[d] = prev[d] ?? "preserve";
        return next;
      });
      setFile(null);
      setParsed(null);
      setVersion(null);
      setParseError(null);
      setSubmitting(false);
      setV3Outcome(null);
      setLegacyOutcome(null);
      setSubmitError(null);
    }
  }, [open, initialMode]);

  // --- File handling ------------------------------------------------------
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setParseError(null);
    setV3Outcome(null);
    setLegacyOutcome(null);
    setSubmitError(null);

    const reader = new FileReader();
    reader.addEventListener("load", (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        const v = detectVersion(json);
        if (v === null) {
          setParseError(
            "Unrecognized manifest: missing `version` field. Only versions 1, 2, and 3 are supported.",
          );
          setParsed(null);
          setVersion(null);
          return;
        }
        setParsed(json);
        setVersion(v);
        // For v3: seed the dispositions + identity policy from the manifest.
        if (v === 3) {
          const m = readMode(json);
          if (m && m !== initialMode) {
            // The manifest's mode conflicts with the route. Don't auto-set;
            // submit will reject with 400. We surface a hint here.
            setParseError(
              `Manifest mode "${m}" does not match the import target (${initialMode}). Use the ${
                initialMode === "new" ? "/habitats/import" : "habitat-replacement"
              } entry point.`,
            );
            return;
          }
          const next = {} as Record<ImportManifestDomainName, ImportDisposition>;
          for (const d of DOMAIN_NAMES) next[d] = readDisposition(json, d);
          setDispositions(next);
          setIdentityPolicy(readIdentityPolicy(json));
        }
      } catch (err) {
        setParseError((err as Error).message);
        setParsed(null);
        setVersion(null);
      }
    });
    reader.readAsText(selectedFile);
  };

  // --- Submit -------------------------------------------------------------
  const isFormReady = useMemo(() => {
    if (!parsed || version === null) return false;
    if (submitting) return false;
    if (parseError) return false;
    if (submitError) return false;
    if (v3Outcome || legacyOutcome) return false;
    return true;
  }, [parsed, version, submitting, parseError, submitError, v3Outcome, legacyOutcome]);

  const handleImport = async () => {
    if (!parsed) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      // The API route detects the manifest version internally. The dialog
      // sends the raw parsed JSON — the server handles v1/v2 → adaptUnknown
      // → prepareImport, and v3 → identity-passthrough → prepareImport.
      const targetHabitatId = mode === "replacement" ? habitatId : undefined;
      const response = await importsApi.publish({
        habitatId: targetHabitatId,
        manifest: parsed,
      });

      // The flag-gate is process-restart-scoped; the UI cannot query it.
      // We dispatch on the response shape: v3 (closed union) vs legacy.
      // We lack the HTTP status here (request() throws on non-2xx), so we
      // branch on the body alone. A non-2xx v3 body still carries `outcome`
      // if the kernel mapper produced one (e.g. rejected_preflight → 422).
      const parsed_ = parsePublishImportResponse(200, response);

      if (parsed_.kind === "v3") {
        setV3Outcome(parsed_.outcome);
      } else if (parsed_.kind === "legacy") {
        setLegacyOutcome(parsed_.body);
      } else {
        // Surface the server error envelope.
        setSubmitError(parsed_.body.error ?? `Import failed (status ${parsed_.status})`);
      }
    } catch (err) {
      // The transport's `request()` helper throws `ApiError` on any non-2xx
      // response — but the M3 mapper INTENTIONALLY returns 422/409/404 with
      // the closed-union v3 outcome body intact (rejected_preflight, vetoed,
      // guard_mismatch, illegal_source_state, not_found, already_publishing).
      // The transport preserves the parsed body as `ApiError.body`
      // (additive field added in T10C M4); we recover the typed outcome
      // here so the dialog renders the per-domain errors / per-Task vetoes
      // / "existing state unchanged" banner rather than a generic error.
      if (err instanceof ApiError) {
        const recovered = parseImportApiError(err);
        if (recovered?.kind === "v3") {
          setV3Outcome(recovered.outcome);
          return;
        }
        if (recovered?.kind === "legacy") {
          setLegacyOutcome(recovered.body);
          return;
        }
      }
      // Fallback: generic submit error (no structured body or unknown shape).
      const message = err instanceof Error ? err.message : "Import failed";
      setSubmitError(message);
      notify.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setFile(null);
    setParsed(null);
    setVersion(null);
    setParseError(null);
    setV3Outcome(null);
    setLegacyOutcome(null);
    setSubmitError(null);
    onClose();
  };

  const handleNavigateToHabitat = (id: string, resolvedMode: "new" | "replacement") => {
    onImport(id, resolvedMode);
    handleClose();
  };

  // --- Render -------------------------------------------------------------

  const renderFileChooser = () => (
    <div className="space-y-4" data-testid="file-chooser">
      <p className="text-sm text-muted-foreground">
        Select a habitat export JSON file (manifest v1, v2, or v3). The file's
        version is auto-detected.
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileChange}
        className="hidden"
        data-testid="file-input"
      />
      <Button
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        className="w-full"
        data-testid="choose-file-btn"
      >
        Choose File
      </Button>
    </div>
  );

  const renderParseError = () => (
    <div className="space-y-4" data-testid="parse-error">
      <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
        {parseError}
      </div>
      <Button
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        className="w-full"
        data-testid="choose-different-btn"
      >
        Choose Different File
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );

  const renderDispositionRow = (domain: ImportManifestDomainName) => {
    const current = dispositions[domain];
    return (
      <div
        key={domain}
        className="flex items-center justify-between gap-3 py-2 border-b last:border-b-0"
        data-testid={`disposition-row-${domain}`}
      >
        <div className="text-sm">
          <div className="font-medium">{DOMAIN_LABELS[domain]}</div>
        </div>
        <div className="flex gap-1">
          {(["replace", "preserve", "reset"] as ImportDisposition[]).map((d) => (
            <label
              key={d}
              className="flex items-center gap-1 cursor-pointer text-xs"
              data-testid={`disposition-${domain}-${d}`}
            >
              <input
                type="radio"
                name={`disposition-${domain}`}
                value={d}
                checked={current === d}
                onChange={() => setDispositions({ ...dispositions, [domain]: d })}
              />
              <span>{DISPOSITION_LABELS[d]}</span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  const renderConfigForm = () => (
    <div className="space-y-4" data-testid="config-form">
      <div className="p-3 bg-muted rounded text-sm">
        <div className="font-medium">{file?.name ?? "manifest"}</div>
        <div className="text-xs text-muted-foreground">
          Detected version: v{version}
          {version === 3 && (
            <>
              {" "}
              · manifestId: <code className="text-xs">{readManifestId(parsed) ?? "—"}</code>
            </>
          )}
        </div>
      </div>

      {/* Mode selector */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Import mode:</p>
        <label className="flex items-center gap-3 cursor-pointer text-sm">
          <input
            type="radio"
            name="mode"
            value="new"
            checked={mode === "new"}
            disabled={!!habitatId}
            onChange={() => setMode("new")}
            data-testid="mode-new"
          />
          <span>
            <strong>New habitat:</strong> Create a fresh habitat from the manifest
          </span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer text-sm">
          <input
            type="radio"
            name="mode"
            value="replacement"
            checked={mode === "replacement"}
            disabled={!habitatId}
            onChange={() => setMode("replacement")}
            data-testid="mode-replacement"
          />
          <span>
            <strong>Replacement:</strong> Apply manifest onto the existing habitat
          </span>
        </label>
      </div>

      {/* Identity policy selector */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Identity policy:</p>
        <label className="flex items-center gap-3 cursor-pointer text-sm">
          <input
            type="radio"
            name="identity"
            value="remap"
            checked={identityPolicy === "remap"}
            onChange={() => setIdentityPolicy("remap")}
            data-testid="identity-remap"
          />
          <span>
            <strong>Remap:</strong> Assign fresh server-side ids; structural source IDs stay
            manifest-local
          </span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer text-sm">
          <input
            type="radio"
            name="identity"
            value="restore"
            checked={identityPolicy === "restore"}
            disabled={version !== 3}
            onChange={() => setIdentityPolicy("restore")}
            data-testid="identity-restore"
          />
          <span>
            <strong>Restore:</strong> Same-lineage restore (requires source habitat lineage proof;{" "}
            {version === 3 ? "eligible" : "not eligible for v1/v2 inputs"})
          </span>
        </label>
      </div>

      {/* Per-domain disposition matrix */}
      {version === 3 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Per-domain disposition:</p>
          <div className="p-3 bg-muted rounded">
            <div className="text-xs text-muted-foreground mb-2">
              {Object.entries(DISPOSITION_DESCRIPTIONS)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
            </div>
            {DOMAIN_NAMES.map(renderDispositionRow)}
          </div>
        </div>
      )}
    </div>
  );

  // --- v3 outcome renderers ------------------------------------------------

  const renderV3Outcome = (outcome: ImportOutcomeView) => {
    switch (outcome.outcome) {
      case "published":
        return (
          <div
            className="space-y-3"
            data-testid="outcome-published"
          >
            <div className="p-3 bg-green-100 dark:bg-green-900/20 border border-green-300 dark:border-green-700 rounded">
              <div className="font-medium text-green-900 dark:text-green-100">
                Habitat imported successfully
              </div>
              <div className="text-sm text-green-800 dark:text-green-200 mt-1">
                {outcome.importedCounts && Object.keys(outcome.importedCounts).length > 0
                  ? `Imported counts: ${Object.entries(outcome.importedCounts)
                      .map(([d, n]) => `${d}: ${n}`)
                      .join(", ")}`
                  : "Imported counts: (none)"}
              </div>
            </div>
            <Button
              onClick={() => handleNavigateToHabitat(outcome.habitatId, mode)}
              data-testid="navigate-to-habitat"
            >
              Go to habitat
            </Button>
          </div>
        );
      case "replayed":
        return (
          <div className="space-y-3" data-testid="outcome-replayed">
            <div className="p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded">
              <div className="font-medium text-blue-900 dark:text-blue-100">
                Import replayed (idempotent retry)
              </div>
              <div className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                Previous terminal outcome: <strong>{outcome.terminal}</strong>
              </div>
            </div>
          </div>
        );
      case "rejected_preflight": {
        const { ungrouped, byDomain } = groupErrorsByDomain(outcome.errors);
        return (
          <div className="space-y-3" data-testid="outcome-rejected-preflight">
            {/* Existing habitat state is unchanged banner — required by the
                M4 grounding (the preflight is PURE; nothing commits). */}
            <div
              className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded"
              data-testid="state-unchanged-banner"
            >
              <div className="font-medium text-amber-900 dark:text-amber-100">
                Existing habitat state is unchanged
              </div>
              <div className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                The preflight found validation or governance failures below. Nothing was
                committed; you can fix and retry.
              </div>
            </div>
            {/* Per-domain error grouping */}
            {DOMAIN_NAMES.filter((d) => byDomain[d].length > 0).map((d) => (
              <div
                key={d}
                className="p-3 bg-muted rounded"
                data-testid={`error-group-${d}`}
              >
                <div className="font-medium text-sm mb-1">{DOMAIN_LABELS[d]}</div>
                <ul className="text-xs space-y-1">
                  {byDomain[d].map((e, i) => (
                    <li key={i}>
                      <code className="font-mono">{e.field}</code> · <code className="font-mono">{e.code}</code> · {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {ungrouped.length > 0 && (
              <div className="p-3 bg-muted rounded" data-testid="error-group-ungrouped">
                <div className="font-medium text-sm mb-1">Other</div>
                <ul className="text-xs space-y-1">
                  {ungrouped.map((e, i) => (
                    <li key={i}>
                      <code className="font-mono">{e.field}</code> · <code className="font-mono">{e.code}</code> · {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      }
      case "vetoed": {
        const renderVeto = (v: ImportVetoView) => (
          <li
            key={v.taskSourceId}
            className="text-sm"
            data-testid={`veto-${v.taskSourceId}`}
          >
            <strong>{v.taskTitle}</strong> · {v.veto.interceptorKey}: {v.veto.reason}
          </li>
        );
        return (
          <div className="space-y-3" data-testid="outcome-vetoed">
            <div
              className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded"
              data-testid="state-unchanged-banner"
            >
              <div className="font-medium text-amber-900 dark:text-amber-100">
                Existing habitat state is unchanged
              </div>
              <div className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                Governance refused {outcome.vetoes.length} task(s). Nothing was committed; fix and
                retry.
              </div>
            </div>
            <div className="p-3 bg-muted rounded">
              <div className="font-medium text-sm mb-1">Decisive vetoes</div>
              <ul className="space-y-1">{outcome.vetoes.map(renderVeto)}</ul>
            </div>
          </div>
        );
      }
      case "already_publishing":
        return (
          <div className="space-y-3" data-testid="outcome-already-publishing">
            <div
              className="p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded"
            >
              <div className="font-medium text-blue-900 dark:text-blue-100">
                Import is currently publishing
              </div>
              <div className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                Another worker holds the lease. Re-submit the same manifest to check the durable
                attempt; the request is idempotent and will not create a duplicate import.
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleImport()}
                loading={submitting}
                disabled={submitting}
                className="mt-3"
                data-testid="check-import-status"
              >
                Check status
              </Button>
            </div>
          </div>
        );
      case "guard_mismatch":
        return (
          <div className="space-y-3" data-testid="outcome-guard-mismatch">
            <div
              className="p-3 bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded"
            >
              <div className="font-medium text-amber-900 dark:text-amber-100">
                Guard mismatch — retry required
              </div>
              <div className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                The habitat's <code className="font-mono">{outcome.fields.join(", ")}</code> drifted
                mid-publish. The transaction rolled back; nothing was committed.
              </div>
            </div>
          </div>
        );
      case "illegal_source_state":
        return (
          <div className="space-y-3" data-testid="outcome-illegal-source-state">
            <div
              className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
            >
              <div className="font-medium">Import attempt is in a terminal state</div>
              <div className="mt-1">
                Cannot re-import under the same key. The prior attempt's from-state was{" "}
                <code className="font-mono">{outcome.fromState}</code>.
              </div>
            </div>
          </div>
        );
      case "not_found":
        return (
          <div className="space-y-3" data-testid="outcome-not-found">
            <div
              className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
            >
              <div className="font-medium">Import attempt not found</div>
              <div className="mt-1">The server lost the import-attempt row — a data anomaly.</div>
            </div>
          </div>
        );
      case "already_exists":
        return (
          <div className="space-y-3" data-testid="outcome-already-exists">
            <div
              className="p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded"
            >
              <div className="font-medium text-blue-900 dark:text-blue-100">
                Import attempt already exists
              </div>
              <div className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                An attempt with this manifestId is already in flight or terminal. Retry to replay
                the same key.
              </div>
            </div>
          </div>
        );
      case "feature_disabled":
        return (
          <div className="space-y-3" data-testid="outcome-feature-disabled">
            <div
              className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
            >
              <div className="font-medium">Feature disabled</div>
              <div className="mt-1">
                The v3 import pipeline is not active on this server.
              </div>
            </div>
          </div>
        );
    }
  };

  // --- Legacy fallback renderer --------------------------------------------

  const renderLegacyOutcome = () => {
    if (!legacyOutcome) return null;
    const { imported, warnings } = legacyOutcome;
    return (
      <div className="space-y-3" data-testid="outcome-legacy">
        <div className="p-3 bg-green-100 dark:bg-green-900/20 border border-green-300 dark:border-green-700 rounded">
          <div className="font-medium text-green-900 dark:text-green-100">
            Habitat imported successfully (legacy path)
          </div>
          <div className="text-sm text-green-800 dark:text-green-200 mt-1">
            Imported: {imported.missions} missions · {imported.tasks} tasks ·{" "}
            {imported.comments} comments · {imported.templates} templates ·{" "}
            {imported.webhooks} webhooks
          </div>
        </div>
        {warnings.length > 0 && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm">
            <div className="font-medium">Warnings</div>
            <ul className="list-disc pl-5 mt-1">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <Button
          onClick={() => handleNavigateToHabitat(legacyOutcome.habitat.id, mode)}
          data-testid="navigate-to-habitat-legacy"
        >
          Go to habitat
        </Button>
      </div>
    );
  };

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogHeader>
        <DialogTitle>
          {habitatId ? "Import Into Habitat (v3)" : "Import Habitat (v3)"}
        </DialogTitle>
      </DialogHeader>
      <DialogContent>
        {!parsed && !parseError && renderFileChooser()}
        {parseError && renderParseError()}
        {!!parsed && !parseError && !v3Outcome && !legacyOutcome && renderConfigForm()}
        {v3Outcome && renderV3Outcome(v3Outcome)}
        {legacyOutcome && renderLegacyOutcome()}
        {submitError && !v3Outcome && !legacyOutcome && (
          <div
            className="p-3 mt-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive"
            data-testid="submit-error"
          >
            {submitError}
          </div>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={handleClose} disabled={submitting}>
          {v3Outcome || legacyOutcome ? "Close" : "Cancel"}
        </Button>
        {!v3Outcome && !legacyOutcome && (
          <Button
            onClick={handleImport}
            loading={submitting}
            disabled={!isFormReady}
            data-testid="import-btn"
          >
            {mode === "replacement" ? "Replace" : "Import"}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
