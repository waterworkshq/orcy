import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORCY_PATHS } from "@orcy/shared";
import { withErrorHandling } from "../error-handler.js";
import {
  loadConfig,
  detectClis,
  SUPPORTED_CLIS,
  DaemonApiClient,
  Store,
  PollLoop,
  SessionManager,
  recoverSessions,
} from "@orcy/daemon";

const PID_FILE = path.join(ORCY_PATHS.run, "daemon.pid");
const STARTING_FILE = path.join(ORCY_PATHS.run, "daemon.starting");
const START_LOCK = path.join(ORCY_PATHS.run, "daemon.start.lock");
const LOG_FILE = path.join(ORCY_PATHS.logs, "daemon.log");
const CLI_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

function updatePidFile(pid: number): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearOwnedFile(file: string, pid: number): void {
  try {
    if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file);
  } catch {}
}

function isStarting(pid: number): boolean {
  try {
    return fs.readFileSync(STARTING_FILE, "utf8").trim() === String(pid);
  } catch {
    return false;
  }
}

function stopStarting(): never {
  process.exit(0);
}

function clearOwnedState(pid: number): void {
  try {
    fs.mkdirSync(START_LOCK);
  } catch {
    return; // An acquirer owns the lock; it will handle any stale files.
  }
  try {
    clearOwnedFile(PID_FILE, pid);
    clearOwnedFile(STARTING_FILE, pid);
  } finally {
    fs.rmdirSync(START_LOCK);
  }
}

// Serialize slot acquisition, including replacement of a dead PID. A stranded
// lock fails closed: removing it automatically could race another acquirer.
function reserveDaemonSlot(): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  try {
    fs.mkdirSync(START_LOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Daemon startup reservation is busy. If no start is in progress, remove ${START_LOCK}`, { cause: error });
    }
    throw error;
  }
  try {
    const existing = readPid();
    if (existing && isRunning(existing)) throw new Error(`Daemon already running or starting (pid ${existing})`);
    fs.writeFileSync(STARTING_FILE, String(process.pid));
    updatePidFile(process.pid);
    process.once("exit", () => clearOwnedState(process.pid));
  } catch (error) {
    clearOwnedFile(PID_FILE, process.pid);
    clearOwnedFile(STARTING_FILE, process.pid);
    throw error;
  } finally {
    fs.rmdirSync(START_LOCK);
  }
}

function getDataDir(): string {
  return process.env.ORCY_DAEMON_DIR ?? path.join(ORCY_PATHS.home, "daemon");
}

/** Registers the `orcy daemon` subcommands (detect, register, start, stop, status) on the given {@link Command}. */
export function registerDaemonCommands(program: any) {
  const daemon = program
    .command("daemon")
    .description("Daemon operations — autonomous agent runtime");

  daemon
    .command("detect")
    .description("Detect supported AI CLI tools on this machine")
    .action(() => {
      const found = detectClis();
      if (found.length === 0) {
        console.log("No supported CLIs detected.\n");
        console.log("Supported tools:");
        for (const cli of SUPPORTED_CLIS) {
          console.log(`  ${cli.bin.padEnd(16)} (${cli.type})`);
        }
        return;
      }
      console.log(`Detected ${found.length} CLI(s):\n`);
      for (const cli of found) {
        const version = cli.version ? ` v${cli.version}` : "";
        console.log(`  ${cli.type.padEnd(14)} ${cli.path}${version}`);
      }
      const missing = SUPPORTED_CLIS.filter((s) => !found.some((f) => f.type === s.type));
      if (missing.length > 0) {
        console.log(`\nNot found: ${missing.map((m) => m.bin).join(", ")}`);
      }
    });

  daemon
    .command("register")
    .description("Register this daemon with the Orcy API and save credentials")
    .requiredOption("--habitat-ids <ids>", "Comma-separated habitat IDs to serve")
    .option("--name <name>", "Daemon name (default: hostname)")
    .option(
      "--api-url <url>",
      "API server URL",
      process.env.ORCY_API_URL ?? "http://localhost:3000",
    )
    .option(
      "--registration-token <token>",
      "Registration auth token (or set ORCY_REGISTRATION_TOKEN)",
    )
    .action(
      withErrorHandling(
        async (options: {
          habitatIds: string;
          name?: string;
          apiUrl: string;
          registrationToken?: string;
        }) => {
          const habitatIds = options.habitatIds
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          if (habitatIds.length === 0) {
            throw new Error("At least one habitat ID is required");
          }

          const detected = detectClis();
          if (detected.length === 0) {
            console.log(
              "Warning: No supported CLIs detected. Daemon will not be able to spawn sessions.",
            );
          }

          const config = loadConfig({
            apiUrl: options.apiUrl,
            name: options.name,
            registrationToken:
              options.registrationToken ?? process.env.ORCY_REGISTRATION_TOKEN ?? null,
            habitatIds,
          });

          const apiClient = new DaemonApiClient(config);
          const registration = await apiClient.register(
            config.name,
            os.hostname(),
            "1.0.0",
            detected,
            habitatIds,
          );

          const store = new Store(getDataDir());
          store.saveCredentials({
            daemonId: registration.daemonId,
            daemonToken: registration.daemonToken,
            apiUrl: config.apiUrl,
            habitatIds: config.habitatIds,
            agents: registration.agents,
            registeredAt: new Date().toISOString(),
          });

          console.log(`Daemon registered: ${registration.daemonId}`);
          console.log(`Agents (${registration.agents.length}):`);
          for (const agent of registration.agents) {
            console.log(`  ${agent.name.padEnd(30)} ${agent.type.padEnd(14)} key=${agent.apiKey}`);
          }
          console.log("\nAPI keys are shown only once. Store them securely if needed.");
          console.log("Run `orcy daemon start` to begin autonomous operation.");
        },
      ),
    );

  daemon
    .command("start")
    .description("Start the daemon (blocks by default)")
    .option("--detach", "Run in background")
    .option("--api-url <url>", "API server URL override")
    .option("--max-concurrent <n>", "Max concurrent sessions", "4")
    .option("--poll-interval <sec>", "Poll interval in seconds", "30")
    .option("--timeout <sec>", "Session inactivity timeout in seconds", "600")
    .action(
      withErrorHandling(
        async (options: {
          detach?: boolean;
          apiUrl?: string;
          maxConcurrent: string;
          pollInterval: string;
          timeout: string;
        }) => {
          if (options.detach) {
            const existingPid = readPid();
            if (existingPid && isRunning(existingPid)) {
              if (isStarting(existingPid)) throw new Error(`Daemon is already starting (pid ${existingPid}); startup is pending`);
              console.log(`Daemon already running (pid ${existingPid})`);
              return;
            }

            const args = [CLI_ENTRY, "daemon", "start"];
            if (options.apiUrl) args.push("--api-url", options.apiUrl);
            args.push("--max-concurrent", options.maxConcurrent);
            args.push("--poll-interval", options.pollInterval);
            args.push("--timeout", options.timeout);

            fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
            const log = fs.openSync(LOG_FILE, "a");
            let child;
            try {
              child = spawn(process.execPath, args, {
                stdio: ["ignore", log, log, "ipc"],
                detached: true,
                env: { ...process.env, ORCY_DAEMON_DETACHED_START: "1" },
              });
            } finally {
              fs.closeSync(log);
            }
            await new Promise<void>((resolve, reject) => {
              let permitted = false;
              let cancelledBeforeReservation = false;
              const timer = setTimeout(() => {
                if (!permitted) {
                  cancelledBeforeReservation = true;
                  child.kill("SIGKILL");
                  return;
                }
                child.disconnect();
                child.unref();
                reject(new Error(`Daemon startup is still pending after 15 seconds (pid ${child.pid}). Check status and ${LOG_FILE}`));
              }, 15_000);
              child.once("error", (error) => {
                clearTimeout(timer);
                reject(new Error(`Daemon could not be spawned: ${error.message}. See ${LOG_FILE}`));
              });
              child.once("exit", (code, signal) => {
                clearTimeout(timer);
                if (child.pid) clearOwnedState(child.pid);
                reject(new Error(cancelledBeforeReservation
                  ? `Daemon startup timed out before recovery after 15 seconds. See ${LOG_FILE}`
                  : `Daemon exited during startup (${signal ?? `code ${code}`}). See ${LOG_FILE}`));
              });
              child.on("message", (message) => {
                if (message === "orcy-daemon-reserved" && !cancelledBeforeReservation) {
                  permitted = true;
                  child.send("orcy-daemon-proceed");
                  return;
                }
                if (!permitted || cancelledBeforeReservation || message !== "orcy-daemon-ready") return;
                clearTimeout(timer);
                child.removeAllListeners("exit");
                child.unref();
                resolve();
              });
            });
            console.log(`Daemon started (pid ${child.pid}) — logging to ${LOG_FILE}`);
            return;
          }

          const detachedChild = process.env.ORCY_DAEMON_DETACHED_START === "1";
          reserveDaemonSlot();
          // Stop can terminate startup even while recovery awaits the API.
          process.once("SIGTERM", stopStarting);
          process.once("SIGINT", stopStarting);
          if (detachedChild) {
            if (process.send && process.connected) {
              await new Promise<void>((resolve) => {
                const proceed = (message: unknown) => {
                  if (message === "orcy-daemon-proceed") finish();
                };
                const finish = () => {
                  process.removeListener("message", proceed);
                  process.removeListener("disconnect", finish);
                  resolve();
                };
                process.on("message", proceed);
                process.once("disconnect", finish);
                process.send!("orcy-daemon-reserved", () => { if (!process.connected) finish(); });
              });
            }
          }
          const dataDir = getDataDir();
          const store = new Store(dataDir);
          const creds = store.loadCredentials();
          if (!creds) {
            throw new Error("No credentials found. Run `orcy daemon register` first.");
          }

          const habitatIds = process.env.ORCY_HABITAT_IDS
            ? process.env.ORCY_HABITAT_IDS.split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : (creds.habitatIds ?? []);

          const config = {
            apiUrl: options.apiUrl ?? creds.apiUrl,
            registrationToken: null,
            name: os.hostname(),
            maxConcurrent: parseInt(options.maxConcurrent, 10),
            pollIntervalSeconds: parseInt(options.pollInterval, 10),
            heartbeatIntervalSeconds: 30,
            sessionTimeoutSeconds: parseInt(options.timeout, 10),
            dataDir,
            habitatIds,
          };

          const apiClient = new DaemonApiClient(config);
          apiClient.setDaemonToken(creds.daemonToken);

          const sessionManager = new SessionManager({
            sessionUpdater: apiClient,
            apiUrl: config.apiUrl,
            dataDir: config.dataDir,
            sessionTimeoutSeconds: config.sessionTimeoutSeconds,
            onSessionComplete: (session) => {
              const elapsed = Math.round((Date.now() - session.startedAt) / 1000);
              console.log(
                `Session ${session.id} ${session.status} (${elapsed}s) — task: ${session.taskTitle}`,
              );
            },
          });

          console.log(`Daemon ${creds.daemonId} starting...`);
          console.log(`Agents: ${creds.agents.map((a) => a.name).join(", ")}`);
          console.log(`Max concurrent: ${config.maxConcurrent}`);

          const recoveryResults = await recoverSessions(apiClient, creds.agents);
          if (recoveryResults.length > 0) {
            console.log(`Recovered ${recoveryResults.length} session(s):`);
            for (const r of recoveryResults) {
              console.log(`  ${r.sessionId} → ${r.action} (${r.reason})`);
            }
          }

          sessionManager.startTimeoutCheck();

          const pollLoop = new PollLoop({
            config,
            apiClient,
            sessionManager,
            agents: creds.agents,
          });

          pollLoop.start();

          const shutdown = async () => {
            console.log("\nShutting down...");
            pollLoop.stop();
            await sessionManager.shutdownAll();
            clearOwnedState(process.pid);
            process.exit(0);
          };

          process.removeListener("SIGINT", stopStarting);
          process.removeListener("SIGTERM", stopStarting);
          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
          clearOwnedFile(STARTING_FILE, process.pid);
          console.log("Daemon running. Press Ctrl+C to stop.");
          if (detachedChild && process.send && process.connected) {
            process.send("orcy-daemon-ready", () => { if (process.connected) process.disconnect(); });
          }
        },
      ),
    );

  daemon
    .command("stop")
    .description("Stop the running daemon")
    .action(
      withErrorHandling(async () => {
        const pid = readPid();
        if (!pid || !isRunning(pid)) {
          console.log("Daemon is not running");
          if (pid) clearOwnedState(pid);
          return;
        }
        try {
          process.kill(pid, "SIGTERM");
          console.log(`Stopped daemon (pid ${pid})`);
        } catch {
          console.error("Failed to stop daemon");
        }
      }),
    );

  daemon
    .command("status")
    .description("Show daemon status and configuration")
    .action(() => {
      const pid = readPid();
      const running = pid !== null && isRunning(pid);
      const dataDir = getDataDir();
      const store = new Store(dataDir);
      const creds = store.loadCredentials();

      console.log(`Daemon:  ${running ? (isStarting(pid!) ? "starting" : "running") : "stopped"}`);
      if (running && pid) console.log(`PID:     ${pid}`);

      if (!creds) {
        console.log("Status:  Not registered");
        console.log("\nRun `orcy daemon register` to get started.");
        return;
      }

      console.log(`ID:      ${creds.daemonId}`);
      console.log(`API:     ${creds.apiUrl}`);
      console.log(`Since:   ${creds.registeredAt}`);
      console.log(`\nAgents (${creds.agents.length}):`);
      for (const agent of creds.agents) {
        console.log(`  ${agent.name.padEnd(30)} ${agent.type.padEnd(14)} ${agent.id}`);
      }
    });
}
