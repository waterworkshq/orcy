import React, { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DaemonCard } from "./DaemonCard.js";
import { useDaemons } from "../../lib/useHabitatData.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { Button } from "../ui/Button.js";

interface DaemonSectionProps {
  onSetup?: () => void;
}

export function DaemonSection({ onSetup }: DaemonSectionProps) {
  const { data, isLoading, error, refetch } = useDaemons();
  const queryClient = useQueryClient();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const daemons = data?.daemons ?? [];

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.daemons.list() });
  }, [queryClient]);

  const handleStart = useCallback(
    async (id: string) => {
      setActionLoading(id);
      try {
        await api.daemons.start(id);
        notify.success("Daemon started");
        invalidate();
      } catch (err) {
        notify.error((err as Error).message);
      } finally {
        setActionLoading(null);
      }
    },
    [invalidate],
  );

  const handleStop = useCallback(
    async (id: string) => {
      setActionLoading(id);
      try {
        await api.daemons.stop(id);
        notify.success("Daemon stopped");
        invalidate();
      } catch (err) {
        notify.error((err as Error).message);
      } finally {
        setActionLoading(null);
      }
    },
    [invalidate],
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Daemons</h3>
        <div className="animate-pulse rounded-lg border border-border bg-card p-4 h-24" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Daemons</h3>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">
            Failed to load daemons: {(error as Error).message}
          </p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (daemons.length === 0) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Daemons</h3>
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No daemons registered. Set up autonomous mode from the CLI or use the setup wizard.
          </p>
          {onSetup && (
            <Button size="sm" className="mt-3" onClick={onSetup}>
              Set Up Autonomous Mode
            </Button>
          )}
        </div>
      </div>
    );
  }

  const onlineCount = daemons.filter((d) => d.status === "online").length;
  const totalSessions = daemons.reduce((sum, d) => sum + d.activeSessionCount, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Daemons</h3>
        <p className="text-xs text-muted-foreground">
          {daemons.length} daemon{daemons.length !== 1 ? "s" : ""} ({onlineCount} online),{" "}
          {totalSessions} active session{totalSessions !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {daemons.map((daemon) => (
          <DaemonCard
            key={daemon.id}
            daemon={daemon}
            onStart={handleStart}
            onStop={handleStop}
            isActionLoading={actionLoading === daemon.id}
            isActionDisabled={actionLoading !== null}
          />
        ))}
      </div>
    </div>
  );
}
