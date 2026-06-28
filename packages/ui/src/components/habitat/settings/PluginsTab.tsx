import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, Puzzle, Trash2, History } from "lucide-react";
import { api } from "../../../api/index.js";
import { queryKeys } from "../../../lib/queryKeys.js";
import { notify } from "../../../lib/toast.js";
import { ToggleSwitch } from "../../ui/ToggleSwitch.js";
import { Button } from "../../ui/Button.js";

interface PluginsTabProps {
  habitatId: string;
}

interface EnrollmentRecord {
  id?: string;
  pluginId?: string;
  contributionId?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  createdAt?: string;
}

interface LoadedPluginContribution {
  id?: string;
  kind?: string;
  description?: string;
}

interface LoadedPluginRecord {
  id?: string;
  pluginId?: string;
  name?: string;
  version?: string;
  description?: string;
  contributions?: LoadedPluginContribution[];
}

interface PluginRunRecord {
  id?: string;
  pluginId?: string;
  contributionId?: string;
  status?: string;
  signalsEmitted?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

function asEnrollment(r: Record<string, unknown>): EnrollmentRecord {
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    pluginId: typeof r.pluginId === "string" ? r.pluginId : undefined,
    contributionId: typeof r.contributionId === "string" ? r.contributionId : undefined,
    enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
    config:
      r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
  };
}

function asLoadedPlugin(r: Record<string, unknown>): LoadedPluginRecord {
  const contributions = Array.isArray(r.contributions)
    ? (r.contributions as unknown[])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => ({
          id: typeof c.id === "string" ? c.id : undefined,
          kind: typeof c.kind === "string" ? c.kind : undefined,
          description: typeof c.description === "string" ? c.description : undefined,
        }))
    : [];
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    pluginId: typeof r.pluginId === "string" ? r.pluginId : undefined,
    name: typeof r.name === "string" ? r.name : undefined,
    version: typeof r.version === "string" ? r.version : undefined,
    description: typeof r.description === "string" ? r.description : undefined,
    contributions,
  };
}

function asRun(r: Record<string, unknown>): PluginRunRecord {
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    pluginId: typeof r.pluginId === "string" ? r.pluginId : undefined,
    contributionId: typeof r.contributionId === "string" ? r.contributionId : undefined,
    status: typeof r.status === "string" ? r.status : undefined,
    signalsEmitted: typeof r.signalsEmitted === "number" ? r.signalsEmitted : undefined,
    error: typeof r.error === "string" ? r.error : undefined,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : undefined,
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : undefined,
  };
}

function fmtTime(v: string | undefined): string {
  return v ? new Date(v).toLocaleString() : "—";
}

export function PluginsTab({ habitatId }: PluginsTabProps) {
  const qc = useQueryClient();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const enrollmentsQuery = useQuery({
    queryKey: queryKeys.plugins.enrollments(habitatId),
    queryFn: async () => {
      const res = await api.plugins.listEnrollments(habitatId);
      return (res.enrollments ?? [])
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map(asEnrollment);
    },
  });

  const loadedQuery = useQuery({
    queryKey: queryKeys.plugins.loaded(),
    queryFn: async () => {
      const res = await api.plugins.listLoaded();
      return (res.plugins ?? [])
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map(asLoadedPlugin);
    },
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.plugins.runs(habitatId),
    queryFn: async () => {
      const res = await api.plugins.listRuns(habitatId, { limit: 20 });
      return (res.runs ?? [])
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map(asRun);
    },
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.plugins.updateEnrollment(habitatId, id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.plugins.enrollments(habitatId) });
      notify.success("Enrollment updated");
    },
    onError: (err: Error) => notify.error(err.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.plugins.deleteEnrollment(habitatId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.plugins.enrollments(habitatId) });
      setConfirmDeleteId(null);
      notify.success("Enrollment removed");
    },
    onError: (err: Error) => notify.error(err.message),
  });

  const enrollments = enrollmentsQuery.data ?? [];
  const loaded = loadedQuery.data ?? [];
  const runs = runsQuery.data ?? [];

  return (
    <div className="space-y-6">
      {/* Section 1: Available plugins */}
      <section>
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
          <Puzzle className="h-4 w-4" /> Available Plugins
        </h3>
        {loadedQuery.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--on-surface-variant)]" />
        ) : loadedQuery.error ? (
          <div className="text-xs text-[var(--error)] flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Failed to load plugins manifest.
          </div>
        ) : loaded.length === 0 ? (
          <p className="text-xs text-[var(--on-surface-variant)]">No plugins loaded.</p>
        ) : (
          <div className="space-y-2">
            {loaded.map((p) => (
              <div
                key={p.id ?? p.pluginId ?? p.name}
                className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-2.5"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold">
                    {p.name ?? p.pluginId ?? "(unnamed)"}
                  </span>
                  {p.version && (
                    <code className="text-[10px] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
                      {p.version}
                    </code>
                  )}
                </div>
                {p.description && (
                  <p className="text-xs text-[var(--on-surface-variant)] mt-0.5">{p.description}</p>
                )}
                {p.contributions && p.contributions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {p.contributions.map((c) => (
                      <code
                        key={c.id ?? `${c.kind}:${c.description}`}
                        className="text-[10px] bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] px-1.5 py-0.5 rounded"
                      >
                        {c.kind ?? "contribution"}
                        {c.id ? `:${c.id}` : ""}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Enrolled plugins */}
      <section>
        <h3 className="text-sm font-semibold mb-2">Enrolled Plugins</h3>
        {enrollmentsQuery.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--on-surface-variant)]" />
        ) : enrollmentsQuery.error ? (
          <div className="text-xs text-[var(--error)] flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Failed to load enrollments.
          </div>
        ) : enrollments.length === 0 ? (
          <p className="text-xs text-[var(--on-surface-variant)]">
            No plugin enrollments. Create enrollments via the API or plugin manager.
          </p>
        ) : (
          <div className="space-y-2">
            {enrollments.map((e) => (
              <div
                key={e.id}
                className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-2.5 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {e.pluginId ?? "(no plugin)"}
                    {e.contributionId && (
                      <code className="ml-2 text-[10px] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
                        {e.contributionId}
                      </code>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--on-surface-variant)]">
                    enrolled {fmtTime(e.createdAt)}
                  </div>
                </div>
                <ToggleSwitch
                  checked={!!e.enabled}
                  onChange={(next) => e.id && toggleMut.mutate({ id: e.id, enabled: next })}
                />
                {confirmDeleteId === e.id ? (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="destructive"
                      onClick={() => e.id && deleteMut.mutate(e.id)}
                      loading={deleteMut.isPending}
                    >
                      Confirm
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="Remove enrollment"
                    onClick={() => e.id && setConfirmDeleteId(e.id)}
                    className="text-[var(--on-surface-variant)] hover:text-[var(--error)] transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 3: Recent runs */}
      <section>
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
          <History className="h-4 w-4" /> Recent Plugin Runs
        </h3>
        {runsQuery.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--on-surface-variant)]" />
        ) : runsQuery.error ? (
          <div className="text-xs text-[var(--error)] flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Failed to load runs.
          </div>
        ) : runs.length === 0 ? (
          <p className="text-xs text-[var(--on-surface-variant)]">No plugin runs recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--on-surface-variant)] border-b border-[var(--outline-variant)]">
                  <th className="py-1.5 pr-3">Plugin</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Signals</th>
                  <th className="py-1.5 pr-3">Error</th>
                  <th className="py-1.5 pr-3">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--outline-variant)]/50">
                    <td className="py-1.5 pr-3 font-mono">{r.pluginId ?? "—"}</td>
                    <td className="py-1.5 pr-3">{r.status ?? "—"}</td>
                    <td className="py-1.5 pr-3">{r.signalsEmitted ?? 0}</td>
                    <td className="py-1.5 pr-3 max-w-[200px] truncate text-[var(--error)]">
                      {r.error ?? ""}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fmtTime(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
