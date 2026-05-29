import React, { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { queryKeys } from "../../lib/queryKeys.js";
import type { DetectedCli } from "../../types/index.js";

type Step = "detect" | "configure" | "register" | "start";

interface DaemonSetupDialogProps {
  open: boolean;
  onClose: () => void;
  habitatIds: string[];
}

export function DaemonSetupDialog({ open, onClose, habitatIds }: DaemonSetupDialogProps) {
  const [step, setStep] = useState<Step>("detect");
  const [loading, setLoading] = useState(false);
  const [detectedClis, setDetectedClis] = useState<DetectedCli[]>([]);
  const [name, setName] = useState("local-daemon");
  const [maxConcurrent, setMaxConcurrent] = useState("4");
  const [daemonId, setDaemonId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const queryClient = useQueryClient();

  const handleDetect = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.daemons.detectClis();
      setDetectedClis(result.clis);
      setStep("configure");
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRegister = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.daemons.register({
        name,
        habitatIds,
        maxConcurrent: parseInt(maxConcurrent, 10) || 4,
      });
      setDaemonId(result.daemonId);
      setAgents(result.agents.map((a) => ({ id: a.id, name: a.name, type: a.type })));
      setStep("start");
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name, maxConcurrent, habitatIds]);

  const handleStart = useCallback(async () => {
    if (!daemonId) return;
    setLoading(true);
    try {
      await api.daemons.start(daemonId);
      notify.success("Daemon started");
      queryClient.invalidateQueries({ queryKey: queryKeys.daemons.list() });
      onClose();
      setStep("detect");
      setDetectedClis([]);
      setDaemonId(null);
      setAgents([]);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [daemonId, queryClient, onClose]);

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Set Up Autonomous Mode</DialogTitle>
      </DialogHeader>
      <DialogContent>
        {step === "detect" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Detect available AI CLI tools on this machine.
            </p>
            <Button onClick={handleDetect} loading={loading}>
              Detect CLIs
            </Button>
          </div>
        )}

        {step === "configure" && (
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-2">Detected CLIs</h4>
              {detectedClis.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No CLIs detected. Install Claude Code, Codex, or other supported tools and try
                  again.
                </p>
              ) : (
                <ul className="space-y-1">
                  {detectedClis.map((cli) => (
                    <li key={cli.type} className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{cli.type}</span>
                      {cli.version && <span className="text-muted-foreground">v{cli.version}</span>}
                      <span className="text-xs text-muted-foreground">{cli.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <label htmlFor="daemon-name" className="mb-1 block text-sm font-medium">
                Daemon Name
              </label>
              <input
                id="daemon-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label htmlFor="daemon-max-concurrent" className="mb-1 block text-sm font-medium">
                Max Concurrent Sessions
              </label>
              <input
                id="daemon-max-concurrent"
                type="number"
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)}
                min={1}
                max={16}
                className="w-24 rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <Button onClick={handleRegister} loading={loading} disabled={detectedClis.length === 0}>
              Register Daemon
            </Button>
          </div>
        )}

        {step === "start" && (
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-2">Registered Agents</h4>
              <ul className="space-y-1">
                {agents.map((agent) => (
                  <li key={agent.id} className="text-sm">
                    <span className="font-medium">{agent.name}</span>
                    <span className="text-muted-foreground ml-2">({agent.type})</span>
                  </li>
                ))}
              </ul>
            </div>
            <Button onClick={handleStart} loading={loading}>
              Start Daemon
            </Button>
          </div>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
