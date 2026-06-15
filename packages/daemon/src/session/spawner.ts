import { spawn, type ChildProcess } from "node:child_process";
import { getAdapter } from "./adapters.js";
import type { CliType } from "../types.js";

/** Result of {@link spawnCli}: the OS pid and the live `ChildProcess` handle for a spawned CLI. */
export interface SpawnedProcess {
  pid: number;
  child: ChildProcess;
}

/** Streaming callbacks wired to the spawned CLI's stdout, stderr, exit, and spawn-error events. */
export interface SpawnCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
}

/** Spawns a CLI in `workdir` with the adapter-derived args/env, returning the live process and wiring output/exit callbacks. */
export function spawnCli(
  type: CliType,
  taskId: string,
  taskTitle: string,
  workdir: string,
  agentId: string,
  agentApiKey: string,
  apiUrl: string,
  binPath: string,
  callbacks: SpawnCallbacks,
): SpawnedProcess {
  const adapter = getAdapter(type);
  const args = adapter.buildArgs(taskId, taskTitle, workdir);
  const env = {
    ...process.env,
    ...adapter.buildEnv(agentApiKey, agentId, apiUrl),
  };

  const child = spawn(binPath || adapter.bin, args, {
    cwd: workdir,
    env: env as Record<string, string>,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    callbacks.onStdout(text);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    callbacks.onStderr(text);
  });

  child.on("exit", (code, signal) => {
    callbacks.onExit(code, signal as NodeJS.Signals | null);
  });

  child.on("error", (error) => {
    callbacks.onError(error);
  });

  if (!child.pid) {
    throw new Error(`Failed to spawn ${type} process (no PID)`);
  }

  return { pid: child.pid, child };
}

/** Sends a signal (default `SIGTERM`) to a spawned CLI; returns `true` if the signal was delivered. */
export function terminateProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    if (child.killed) return false;
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}
