import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getContext } from "./context.js";
import { installPackages } from "./install-packages.js";
import { generateEnvFile } from "./env-bootstrap.js";
import { registerAgent, generateMcpServerBlock } from "./credentials.js";
import { ALL_WRITERS, writeMcpConfig } from "./writers/index.js";
import { injectIntoFile } from "./markdown-injector.js";
import { installSkills, determineSkillsToInstall } from "./skill-installer.js";
import { installService } from "./service-installer.js";
import { addComponent } from "./manifest.js";
import {
  journalExists,
  readJournal,
  createJournal,
  commitJournal,
  discardJournal,
  journalPath,
} from "./journal.js";
import {
  rollbackJournal,
  isJournalViable,
  orphanedAgentIds,
  isJournalCommitted,
} from "./lifecycle.js";

export interface WizardOptions {
  components?: string[];
  mcpClients?: string[];
  patchFiles?: string[];
  skillRoots?: string[];
  local?: boolean;
  interactive?: boolean;
  recover?: boolean;
}

async function askComponents(interactive: boolean): Promise<string[]> {
  if (!interactive) return ["cli", "api", "mcp"];
  const { multiselect } = await import("@clack/prompts");
  const selected = await multiselect<string>({
    message: "Which components to install?",
    options: [
      { value: "cli", label: "CLI (orcy)", hint: "Command-line tool for habitat management" },
      { value: "api", label: "API (orcy-api)", hint: "REST API server + Web UI (served at /app)" },
      { value: "mcp", label: "MCP (orcy-mcp)", hint: "MCP server for AI agents" },
    ],
    initialValues: ["cli", "api", "mcp"],
  });
  return (selected as string[]) || [];
}

async function askApiConfig(
  interactive: boolean,
): Promise<{ port: number; host: string; autostart: boolean }> {
  if (!interactive) return { port: 4000, host: "127.0.0.1", autostart: true };
  const { text, confirm } = await import("@clack/prompts");
  const portStr = await text({
    message: "API port?",
    defaultValue: "4000",
    validate: (v: string) => (/^\d+$/.test(v) ? undefined : "Must be a number"),
  });
  const host = await text({ message: "API host?", defaultValue: "127.0.0.1" });
  const autostart = await confirm({
    message: "Install as a system service (auto-start on login)?",
    initialValue: true,
  });
  return {
    port: parseInt(portStr as string, 10) || 3000,
    host: (host as string) || "127.0.0.1",
    autostart: autostart as boolean,
  };
}

async function askMcpClients(interactive: boolean): Promise<string[]> {
  if (!interactive) return ALL_WRITERS.filter((w) => w.isAvailable).map((w) => w.id);
  const { multiselect } = await import("@clack/prompts");
  const available = ALL_WRITERS.filter((w) => w.isAvailable);
  if (!available.length) {
    console.log("    No agent clients detected on this machine.");
    return [];
  }
  const selected = await multiselect<string>({
    message: "Register MCP with which agent clients?",
    options: available.map((w) => ({ value: w.id, label: w.label, hint: w.configPath })),
  });
  return (selected as string[]) || [];
}

async function askPatchFiles(interactive: boolean): Promise<string[]> {
  const home = os.homedir();
  const candidates = [
    { value: path.join(home, "AGENTS.md"), label: "~/AGENTS.md" },
    { value: path.join(home, "CLAUDE.md"), label: "~/CLAUDE.md" },
    { value: path.join(home, ".claude", "CLAUDE.md"), label: "~/.claude/CLAUDE.md" },
  ].filter((c) => fs.existsSync(c.value));

  if (!interactive) return candidates.map((c) => c.value);
  if (!candidates.length) return [];

  const { multiselect } = await import("@clack/prompts");
  const selected = await multiselect<string>({
    message: "Patch which agent instruction files?",
    options: candidates,
  });
  return (selected as string[]) || [];
}

async function askSkillRoots(interactive: boolean): Promise<string[]> {
  const home = os.homedir();
  const candidates = [
    {
      value: path.join(home, ".claude", "skills"),
      label: "~/.claude/skills/",
      hint: "Claude Code, Claude Desktop",
    },
    { value: path.join(home, ".kilo", "skills"), label: "~/.kilo/skills/", hint: "Kilo CLI" },
    { value: path.join(home, ".codex", "skills"), label: "~/.codex/skills/", hint: "OpenAI Codex" },
  ].filter((c) => fs.existsSync(path.dirname(c.value)));

  if (!interactive) return [path.join(home, ".claude", "skills")];
  if (!candidates.length) {
    const defaultPath = path.join(home, ".claude", "skills");
    fs.mkdirSync(defaultPath, { recursive: true });
    return [defaultPath];
  }
  const { multiselect } = await import("@clack/prompts");
  const selected = await multiselect<string>({
    message: "Install skill files to which roots?",
    options: candidates,
  });
  return (selected as string[]) || [];
}

export async function wizard(opts: WizardOptions = {}): Promise<void> {
  const {
    components: initComponents,
    mcpClients: initMcpClients,
    patchFiles: initPatchFiles,
    skillRoots: initSkillRoots,
    local = false,
    interactive = true,
    recover = false,
  } = opts;

  const ctx = getContext();

  // G2.2: stale-journal detection with viability-aware recovery.
  // Interactive: offer resume / rollback / abort based on viability.
  // Non-interactive + --recover: auto-recover (resume if viable, else rollback).
  // Non-interactive without --recover: safe-by-default structured fail (P1.4).
  if (journalExists()) {
    const stale = readJournal();
    // T2.5: both-files post-commit window — the commit's writeManifest finished
    // (the manifest already contains the journal's done steps) but the journal
    // unlink was interrupted. Finalize silently instead of offering recovery,
    // which could roll back legitimately-committed artifacts.
    if (stale && isJournalCommitted(stale)) {
      console.log(
        "A previous install committed successfully but left a stale journal; clearing it.",
      );
      discardJournal();
    } else {
      const viable = stale ? isJournalViable(stale) : false;
      // G2H.2: surface orphaned remote agents (a registerAgent POST that succeeded
      // but whose local credential write did not). The installer can't self-delete
      // them (the apiKey was never stored), so warn the user to clean them up.
      const orphans = stale ? orphanedAgentIds(stale) : [];
      if (orphans.length) {
        console.error(
          `\n⚠ Interrupted registration left ${orphans.length} orphaned remote agent(s): ${orphans.join(", ")}`,
        );
        console.error(
          "  These were created on the API but never activated locally. Delete them via the admin API/UI.",
        );
      }
      if (interactive) {
        console.log("\n⚠ A previous installation was interrupted.");
        if (stale) {
          const doneCount = stale.steps.filter((s) => s.status === "done").length;
          const lastDone = [...stale.steps].reverse().find((s) => s.status === "done");
          console.log(`  Started: ${stale.startedAt}`);
          console.log(`  Steps recorded: ${stale.steps.length} (${doneCount} completed)`);
          if (lastDone) console.log(`  Last completed: ${lastDone.path} (${lastDone.action})`);
        } else {
          console.log("  (Journal is unreadable — treating as stale.)");
        }
        const { select } = await import("@clack/prompts");
        const options: { value: string; label: string; hint?: string }[] = [];
        if (viable) {
          options.push({
            value: "resume",
            label: "Resume",
            hint: "complete the install — done steps converge",
          });
        }
        options.push({
          value: "rollback",
          label: "Roll back",
          hint: "undo partial, then start fresh",
        });
        options.push({ value: "abort", label: "Abort" });
        const choice = await select({
          message: "How would you like to proceed?",
          options,
        });
        // T4.2: @clack returns a cancel symbol on Ctrl-C / Esc — treat ANY
        // non-string or unknown value as abort (don't fall through to resume).
        if (typeof choice !== "string" || (choice !== "resume" && choice !== "rollback")) {
          console.log("Aborted.");
          return;
        }
        if (choice === "rollback") {
          if (stale) {
            const { reversed, failed } = rollbackJournal(ctx, stale);
            console.log(`  Rolled back ${reversed} step(s)${failed ? ` (${failed} failed)` : ""}.`);
            // G2H.3: an incomplete rollback must NOT be discarded + continued over —
            // the disk state is partly reversed; preserve the journal and abort so
            // the user can retry/inspect rather than install over a half-cleaned state.
            if (failed > 0) {
              console.error(
                "  Rollback incomplete — journal preserved. Re-run to retry or remove the journal manually.",
              );
              return;
            }
          }
          discardJournal();
        } else {
          // resume — discard journal and re-run; G8 idempotency makes done steps converge.
          discardJournal();
        }
      } else if (recover) {
        if (viable) {
          console.log("Stale journal detected — resuming (viable).");
          discardJournal();
        } else {
          console.log("Stale journal detected — rolling back (not viable), then starting fresh.");
          if (stale) {
            const { reversed, failed } = rollbackJournal(ctx, stale);
            console.log(`  Rolled back ${reversed} step(s)${failed ? ` (${failed} failed)` : ""}.`);
            if (failed > 0) {
              console.error(
                "  Rollback incomplete — aborting recovery (journal preserved). Re-run to retry.",
              );
              return;
            }
          }
          discardJournal();
        }
      } else {
        console.error("Error: stale installation journal detected.");
        console.error(`  Journal: ${journalPath()}`);
        if (stale) {
          const doneCount = stale.steps.filter((s) => s.status === "done").length;
          console.error(`  Started: ${stale.startedAt}`);
          console.error(`  Completed steps: ${doneCount}`);
        }
        console.error(
          "  To resolve: run with --recover, remove the journal file, or run interactively.",
        );
        throw new Error(
          `stale installation journal detected — run with --recover, interactively, or remove ${journalPath()}`,
        );
      }
    } // end T2.5 committed-else (recovery)
  }

  console.log("orcy -- Installation wizard\n");

  const components = initComponents ?? (await askComponents(interactive));
  if (!components.length) {
    console.log("Nothing selected. Run `orcy-install --help` for usage.");
    return;
  }

  const apiConfig = components.includes("api")
    ? await askApiConfig(interactive)
    : { port: 4000, host: "127.0.0.1", autostart: false };

  const mcpClients = components.includes("mcp")
    ? (initMcpClients ?? (await askMcpClients(interactive)))
    : [];

  const patchFiles = initPatchFiles ?? (await askPatchFiles(interactive));
  const skillRoots = initSkillRoots ?? (await askSkillRoots(interactive));

  if (interactive) {
    const { confirm } = await import("@clack/prompts");
    const confirmed = await confirm({ message: "Proceed with installation?", initialValue: true });
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  } else {
    console.log("\n==> Installation plan:\n");
    console.log(`  Components:  ${components.join(", ")}`);
    console.log(
      `  API:         ${apiConfig.host}:${apiConfig.port}${apiConfig.autostart ? " (auto-start service)" : ""}`,
    );
    console.log(`  MCP clients: ${mcpClients.length ? mcpClients.join(", ") : "(none)"}`);
    console.log(
      `  Agent files: ${patchFiles.length ? patchFiles.map((p) => path.basename(p)).join(", ") : "(none)"}`,
    );
    console.log(`  Skill roots: ${skillRoots.length ? skillRoots.join(", ") : "(none)"}`);
    console.log("");
  }

  // Start the in-flight transaction journal. Must exist before any record()/
  // addComponent() call in the install body below. On success, commitJournal()
  // builds the manifest from done entries and deletes the journal. If the
  // wizard throws mid-install, commitJournal is never reached → the journal
  // stays on disk → the next run detects it as stale (G2).
  createJournal({ intent: { components, mcpClients, patchFiles, skillRoots, apiConfig } });

  console.log("\n==> Installing...\n");

  fs.mkdirSync(ctx.orcyHome, { recursive: true });

  if (components.includes("api")) {
    generateEnvFile(ctx, { port: apiConfig.port, host: apiConfig.host });
    addComponent("api");
  }
  if (components.includes("cli")) {
    addComponent("cli");
  }

  console.log("==> Installing packages...");
  await installPackages(ctx, components, { local });
  console.log("    Packages installed.");

  if (components.includes("api") && apiConfig.autostart) {
    console.log("==> Installing service...");
    installService(ctx);
  }

  if (components.includes("mcp")) {
    console.log("==> Registering agent...");
    const registered = await registerAgent(ctx);
    if (!registered) {
      console.log("    Could not register agent with the API. Skipping MCP config writes.");
      console.log("    Start the API server and run `orcy-install` again to configure MCP.");
    } else {
      const block = generateMcpServerBlock(registered, ctx);

      for (const clientId of mcpClients) {
        const writer = ALL_WRITERS.find((w) => w.id === clientId);
        if (!writer) continue;
        try {
          writeMcpConfig(writer, block);
          console.log(`    Registered MCP with ${writer.label}: ${writer.configPath}`);
        } catch (e) {
          console.warn(`    Failed to write MCP config for ${clientId}: ${e}`);
        }
      }
    }
    addComponent("mcp");
  }

  for (const filePath of patchFiles) {
    try {
      injectIntoFile(filePath, ctx);
      console.log(`    Patched: ${filePath}`);
    } catch (e) {
      console.warn(`    Could not patch ${filePath}: ${e}`);
    }
  }

  if (skillRoots.length) {
    const skills = determineSkillsToInstall(components);
    console.log("==> Installing skills...");
    installSkills(ctx, skillRoots, skills);
  }

  // Commit: build manifest from journal done-entries, write atomically, delete journal.
  commitJournal();

  console.log("\n==> Installation complete!\n");
  console.log("  ~/.orcy/bin/          PATH shims (ensure ~/.orcy/bin is on your PATH)");
  console.log("  ~/.orcy/.env          API configuration");
  console.log("  ~/.orcy/orcy.db       SQLite database (auto-created)");
  console.log("\n  Run `orcy-install doctor` to verify your installation.");
  console.log("  Run `orcy serve start` to start the API server.");
}
