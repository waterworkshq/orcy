import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Power,
  PowerOff,
  Play,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  ShieldOff,
} from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";

interface CadencePanelProps {
  habitatId: string;
}

type CadenceInterval = "daily" | "weekly" | "monthly";
const INTERVAL_MINUTES: Record<CadenceInterval, number> = {
  daily: 1440,
  weekly: 10080,
  monthly: 43200,
};

export function CadencePanel({ habitatId }: CadencePanelProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [interval, setIntervalValue] = useState<CadenceInterval>("weekly");
  const [showNoUpdate, setShowNoUpdate] = useState(false);
  const [nuFrom, setNuFrom] = useState("");
  const [nuTo, setNuTo] = useState("");
  const [nuReason, setNuReason] = useState("");

  const { data: cadence, isLoading } = useQuery({
    queryKey: queryKeys.wiki.cadence(habitatId),
    queryFn: () => wikiApi.getCadence(habitatId),
    staleTime: 30 * 1000,
  });

  const enableMutation = useMutation({
    mutationFn: () =>
      wikiApi.setCadence(habitatId, {
        enabled: true,
        scheduleType: "interval",
        intervalMinutes: INTERVAL_MINUTES[interval],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.cadence(habitatId) });
      setEnabling(false);
      notify.success("Wiki cadence enabled");
    },
    onError: (err) => notify.error((err as Error).message),
  });

  const disableMutation = useMutation({
    mutationFn: () => wikiApi.disableCadence(habitatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.cadence(habitatId) });
      notify.success("Wiki cadence disabled");
    },
    onError: (err) => notify.error((err as Error).message),
  });

  const bootstrapMutation = useMutation({
    mutationFn: () => wikiApi.bootstrap(habitatId),
    onSuccess: () => notify.success("Queued authoring tasks for uncovered periods"),
    onError: (err) => notify.error((err as Error).message),
  });

  const refreshMutation = useMutation({
    mutationFn: () => wikiApi.refresh(habitatId),
    onSuccess: () => notify.success("Triggered on-demand refresh task"),
    onError: (err) => notify.error((err as Error).message),
  });

  const noUpdateMutation = useMutation({
    mutationFn: () => {
      // The date inputs are `YYYY-MM-DD`; the backend requires ISO datetimes (z.string().datetime()).
      // Treat `from` as the start of the day and `to` as the end of the day so a single date pick
      // covers the whole selected day inclusively.
      const fromIso = nuFrom ? new Date(`${nuFrom}T00:00:00.000Z`).toISOString() : "";
      const toIso = nuTo ? new Date(`${nuTo}T23:59:59.999Z`).toISOString() : "";
      return wikiApi.markNoUpdateNeeded(habitatId, {
        from: fromIso,
        to: toIso,
        reason: nuReason || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.cadence(habitatId) });
      setShowNoUpdate(false);
      setNuFrom("");
      setNuTo("");
      setNuReason("");
      notify.success("No-update-needed marker posted");
    },
    onError: (err) => notify.error((err as Error).message),
  });

  const enabled = cadence?.enabled ?? false;
  const watermark = cadence?.watermark ?? null;
  const busy =
    enableMutation.isPending ||
    disableMutation.isPending ||
    bootstrapMutation.isPending ||
    refreshMutation.isPending;

  return (
    <div className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-low)]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--on-surface-variant)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--on-surface-variant)]" />
        )}
        <CalendarClock className="h-3.5 w-3.5 text-[var(--primary)]" />
        <span className="text-xs font-semibold text-[var(--on-surface)]">Cadence Status</span>
        {enabled && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--tertiary)]/15 text-[var(--tertiary)] shrink-0">
            enabled
          </span>
        )}
        {watermark && (
          <span className="ml-auto text-[9px] text-[var(--on-surface-variant)] shrink-0 hidden sm:inline">
            up to {new Date(watermark).toLocaleDateString()}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {isLoading ? (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--on-surface-variant)]" />
            </div>
          ) : (
            <>
              <div className="rounded-md bg-[var(--surface)] border border-[var(--outline-variant)] px-2.5 py-2">
                <p className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                  Coverage Watermark
                </p>
                <p className="text-xs text-[var(--on-surface)] mt-0.5">
                  {watermark
                    ? `Wiki is current up to ${new Date(watermark).toLocaleString()}`
                    : "No coverage yet."}
                </p>
              </div>

              {enabling ? (
                <div className="space-y-2 rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] p-2.5">
                  <label className="block">
                    <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                      Interval
                    </span>
                    <select
                      value={interval}
                      onChange={(e) => setIntervalValue(e.target.value as CadenceInterval)}
                      className="mt-1 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-2 py-1.5 text-xs text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => enableMutation.mutate()}
                      disabled={enableMutation.isPending}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-semibold bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {enableMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Power className="h-3 w-3" />
                      )}
                      Confirm enable
                    </button>
                    <button
                      type="button"
                      onClick={() => setEnabling(false)}
                      className="px-2.5 py-1 rounded text-[10px] font-semibold text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : enabled ? (
                <button
                  type="button"
                  onClick={() => disableMutation.mutate()}
                  disabled={disableMutation.isPending}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-[var(--outline-variant)] text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
                >
                  {disableMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PowerOff className="h-3.5 w-3.5" />
                  )}
                  Disable cadence
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setEnabling(true)}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90 transition-opacity"
                >
                  <Power className="h-3.5 w-3.5" />
                  Enable cadence
                </button>
              )}

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => bootstrapMutation.mutate()}
                  disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-[var(--outline-variant)] text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
                >
                  {bootstrapMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Bootstrap
                </button>
                <button
                  type="button"
                  onClick={() => refreshMutation.mutate()}
                  disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-[var(--outline-variant)] text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
                >
                  {refreshMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Refresh now
                </button>
              </div>

              <div className="border-t border-[var(--outline-variant)] pt-2">
                <button
                  type="button"
                  onClick={() => setShowNoUpdate((s) => !s)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors"
                >
                  <ShieldOff className="h-3 w-3" />
                  {showNoUpdate ? "Hide" : "Mark period as no-update-needed"}
                </button>
                {showNoUpdate && (
                  <div className="mt-2 rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] p-2.5 space-y-2">
                    <div className="flex gap-1.5">
                      <label className="block flex-1">
                        <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                          From
                        </span>
                        <input
                          type="date"
                          value={nuFrom}
                          onChange={(e) => setNuFrom(e.target.value)}
                          className="mt-0.5 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-2 py-1 text-[10px] text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                        />
                      </label>
                      <label className="block flex-1">
                        <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                          To
                        </span>
                        <input
                          type="date"
                          value={nuTo}
                          onChange={(e) => setNuTo(e.target.value)}
                          className="mt-0.5 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-2 py-1 text-[10px] text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                        />
                      </label>
                    </div>
                    <input
                      type="text"
                      value={nuReason}
                      onChange={(e) => setNuReason(e.target.value)}
                      placeholder="Optional reason…"
                      className="w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-2 py-1 text-[10px] text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                    />
                    <button
                      type="button"
                      onClick={() => noUpdateMutation.mutate()}
                      disabled={!nuFrom || !nuTo || noUpdateMutation.isPending}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-semibold bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {noUpdateMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ShieldOff className="h-3 w-3" />
                      )}
                      Post marker
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
