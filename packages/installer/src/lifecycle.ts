import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { InstallContext } from "./context.js";
import { ALL_WRITERS, removeMcpConfig, writeMcpConfig } from "./writers/index.js";
import { injectIntoFile, removeFromFile } from "./markdown-injector.js";
import { readManifest, writeManifest, hashFile, hashDir, type ManifestEntry } from "./manifest.js";
import { journalExists } from "./journal.js";
import { removeShims, SENTINEL_START, SENTINEL_END } from "./path-shim.js";
import { generateMcpServerBlock, readCredentials } from "./credentials.js";
import { stopService, installService, uninstallService } from "./service-installer.js";
import { generateEnvFile } from "./env-bootstrap.js";
import { installSkills, determineSkillsToInstall } from "./skill-installer.js";

const OLD_SENTINEL_START = "# >>> agent-kanban PATH >>>";
const OLD_SENTINEL_END = "# <<< agent-kanban PATH <<<";
const OLD_SERVICE_UNIT = "kanban-api";
const OLD_SERVICE_PLIST = "ai.kanban.api";

function stopLegacyService(ctx: InstallContext): void {
  if (ctx.platform === "linux") {
    try {
      execSync(`systemctl --user stop ${OLD_SERVICE_UNIT}`, { stdio: "ignore" });
    } catch {}
    try {
      execSync(`systemctl --user disable ${OLD_SERVICE_UNIT}`, { stdio: "ignore" });
    } catch {}
  }
  if (ctx.platform === "darwin") {
    try {
      const uid = execSync("id -u", { encoding: "utf-8" }).trim();
      execSync(`launchctl bootout gui/${uid}/${OLD_SERVICE_PLIST}`, { stdio: "ignore" });
    } catch {}
  }
}

export async function migrateLegacyInstallation(ctx: InstallContext): Promise<boolean> {
  const legacyHome = path.join(os.homedir(), ".kanban");

  if (!fs.existsSync(legacyHome)) return false;
  if (fs.existsSync(ctx.orcyHome)) return false;

  console.log("\n==> Detected legacy ~/.kanban/ installation. Migrating...\n");

  // 1. Stop old service before migration
  console.log("    Stopping legacy service...");
  stopLegacyService(ctx);
  stopService(ctx);

  // 2. Rename directory
  console.log("    Moving ~/.kanban/ → ~/.orcy/...");
  try {
    fs.renameSync(legacyHome, ctx.orcyHome);
    console.log("    Directory migrated.");
  } catch (err) {
    console.error("    Failed to rename ~/.kanban/ → ~/.orcy/:", err);
    throw err;
  }

  // B6: rewrite manifest paths immediately after the rename, BEFORE any other
  // post-rename step. If a later step throws, the manifest must already reflect
  // the new ~/.orcy location — a stale ~/.kanban path makes post-migrate
  // uninstall silently skip the file (existsSync fails → reversal try/catch
  // swallows it).
  const migratedManifest = readManifest();
  if (migratedManifest) {
    let rewrote = false;
    for (const entry of migratedManifest.files) {
      if (entry.path.startsWith(legacyHome)) {
        entry.path = ctx.orcyHome + entry.path.slice(legacyHome.length);
        rewrote = true;
      }
    }
    if (rewrote) {
      writeManifest(migratedManifest);
      console.log("    Rewrote manifest paths ~/.kanban → ~/.orcy.");
    }
  }

  // 3. Rewrite PATH shim sentinels in shell rc files
  console.log("    Updating PATH shims...");
  const rcCandidates: Record<string, string> = {
    bash: path.join(ctx.homeDir, ".bashrc"),
    zsh: path.join(ctx.homeDir, ".zshrc"),
    fish: path.join(ctx.homeDir, ".config", "fish", "config.fish"),
  };
  for (const rcPath of Object.values(rcCandidates)) {
    if (!fs.existsSync(rcPath)) continue;
    try {
      let content = fs.readFileSync(rcPath, "utf-8");
      const hasOld = content.includes(OLD_SENTINEL_START);
      if (hasOld) {
        content = content.replaceAll(OLD_SENTINEL_START, SENTINEL_START);
        content = content.replaceAll(OLD_SENTINEL_END, SENTINEL_END);
        fs.writeFileSync(rcPath, content, "utf-8");
        console.log(`    Updated sentinels in ${rcPath}`);
      }
    } catch {}
  }

  // 4. Remove old service files, install new service
  console.log("    Re-installing service...");
  try {
    uninstallService(ctx);
  } catch {}
  try {
    installService(ctx);
  } catch (e) {
    console.warn(`    Service install failed (continuing migration): ${e}`);
  }

  // 5. Update MCP config key "kanban" → "orcy" in client configs
  console.log("    Updating MCP config...");
  const creds = readCredentials();
  if (creds) {
    const block = generateMcpServerBlock(creds, ctx);
    for (const writer of ALL_WRITERS) {
      if (!writer.isAvailable) continue;
      try {
        if (fs.existsSync(writer.configPath)) {
          if (writer.format === "toml") {
            const { parse, stringify } = await import("smol-toml");
            const data = parse(fs.readFileSync(writer.configPath, "utf-8")) as any;
            if (data.mcp_servers?.kanban) delete data.mcp_servers.kanban;
            data.mcp_servers ??= {};
            fs.writeFileSync(writer.configPath, stringify(data), "utf-8");
          } else {
            const raw = JSON.parse(fs.readFileSync(writer.configPath, "utf-8"));
            const key = writer.format === "opencode" ? "mcp" : "mcpServers";
            if (raw[key]?.kanban) delete raw[key].kanban;
            fs.writeFileSync(writer.configPath, JSON.stringify(raw, null, 2), "utf-8");
          }
        }
        writeMcpConfig(writer, block);
        console.log(`    Updated MCP config: ${writer.label}`);
      } catch (e) {
        console.warn(`    Failed MCP config for ${writer.label}: ${e}`);
      }
    }
  }

  // 6. Rewrite markdown injected blocks (handle old + new markers)
  console.log("    Updating markdown blocks...");
  const manifest = readManifest();
  if (manifest) {
    for (const entry of manifest.files) {
      if (
        entry.action === "fenced" &&
        (entry.path.includes("AGENTS") || entry.path.includes("CLAUDE"))
      ) {
        try {
          const filePath = entry.path;
          if (fs.existsSync(filePath)) {
            let content = fs.readFileSync(filePath, "utf-8");
            const oldStart = "<!-- agent-kanban:start -->";
            const oldEnd = "<!-- agent-kanban:end -->";
            const newStart = "<!-- orcy:start -->";
            const newEnd = "<!-- orcy:end -->";
            if (content.includes(oldStart)) {
              content = content.replace(oldStart, newStart).replace(oldEnd, newEnd);
              fs.writeFileSync(filePath, content, "utf-8");
            }
          }
          removeFromFile(entry.path);
          injectIntoFile(entry.path, ctx);
        } catch (e) {
          console.warn(`    Could not rewrite markdown block in ${entry.path}: ${e}`);
        }
      }
    }
  }

  // 7. Rename skill directories
  console.log("    Updating skill directories...");
  const skillRoots = [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".kilo", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
  ];
  const oldSkills = ["kanban-overview", "kanban-cli-usage", "kanban-mcp-usage"];
  const newSkills = ["orcy-overview", "orcy-cli-usage", "orcy-mcp-usage"];
  for (const root of skillRoots) {
    if (!fs.existsSync(root)) continue;
    for (let i = 0; i < oldSkills.length; i++) {
      const oldSkill = path.join(root, oldSkills[i]);
      const newSkill = path.join(root, newSkills[i]);
      if (fs.existsSync(oldSkill) && !fs.existsSync(newSkill)) {
        try {
          fs.renameSync(oldSkill, newSkill);
          console.log(`    Renamed skill: ${oldSkills[i]} → ${newSkills[i]}`);
        } catch (e) {
          console.warn(`    Could not rename ${oldSkills[i]}: ${e}`);
        }
      }
    }
  }

  console.log("    Migration complete.\n");
  return true;
}

export async function updateInstall(ctx: InstallContext): Promise<void> {
  await migrateLegacyInstallation(ctx);

  // G11: reconcile a v1 (or versionless) manifest to v2 before replaying. Update
  // runs non-interactively, so reconcile auto-applies (it only dedups/rewrites
  // paths/bumps version — never deletes user data).
  const { reconcileManifest } = await import("./reconcile.js");
  await reconcileManifest(ctx, { interactive: false });

  const manifest = readManifest();
  if (!manifest) {
    console.log("No install manifest found. Run install first.");
    return;
  }
  const components = manifest.components;
  console.log(`    Re-installing components: ${components.join(", ")}`);
  const { installPackages } = await import("./install-packages.js");
  await installPackages(ctx, components);

  const intent = manifest.intent;
  if (intent) {
    // Replay env (generateEnvFile self-guards on existing secrets)
    if (components.includes("api") && intent.apiConfig) {
      generateEnvFile(ctx, { port: intent.apiConfig.port, host: intent.apiConfig.host });
    }

    // Replay service (idempotent — Phase 2 guarded bootstrap)
    if (components.includes("api") && intent.apiConfig?.autostart) {
      installService(ctx);
    }

    // Replay MCP config writes (agent already registered — do NOT call registerAgent)
    if (components.includes("mcp") && intent.mcpClients.length) {
      const creds = readCredentials();
      if (creds) {
        const block = generateMcpServerBlock(creds, ctx);
        for (const clientId of intent.mcpClients) {
          const writer = ALL_WRITERS.find((w) => w.id === clientId);
          if (!writer) continue;
          try {
            writeMcpConfig(writer, block);
            console.log(`    Replayed MCP config: ${writer.label}`);
          } catch (e) {
            console.warn(`    Failed to replay MCP config for ${clientId}: ${e}`);
          }
        }
      } else {
        console.log("    Credentials not found — skipping MCP config replay.");
      }
    }

    // Replay markdown patches (remove-then-inject is idempotent via P4.2)
    for (const filePath of intent.patchFiles) {
      try {
        injectIntoFile(filePath, ctx);
      } catch (e) {
        console.warn(`    Could not re-patch ${filePath}: ${e}`);
      }
    }

    // Replay skills
    if (intent.skillRoots.length) {
      installSkills(ctx, intent.skillRoots, determineSkillsToInstall(components));
    }
  } else {
    // Old manifest (no intent recorded) — fall back to packages + markdown re-injection
    console.log(
      "    Install intent not recorded (older install); replaying packages + markdown only.",
    );
    console.log("    Re-run `orcy-install` to enable full update replay.");
    for (const entry of manifest.files) {
      if (entry.action === "fenced") {
        try {
          injectIntoFile(entry.path, ctx);
        } catch (e) {
          console.warn(`    Could not re-patch ${entry.path}: ${e}`);
        }
      }
    }
  }

  console.log("    Update complete");
}

/**
 * P3.2 hash-guard: returns `true` if the on-disk artifact has been modified
 * since install (recorded hash ≠ current hash). When `true`, the caller
 * preserves the artifact instead of removing it (G4/G6 data-loss prevention).
 * Returns `false` when there is no recorded hash or the artifact is unchanged.
 */
function isModifiedSinceInstall(entry: ManifestEntry): boolean {
  if (!entry.hash || !fs.existsSync(entry.path)) return false;
  const currentHash = fs.statSync(entry.path).isDirectory()
    ? hashDir(entry.path)
    : hashFile(entry.path);
  return currentHash !== entry.hash;
}

export interface UninstallOptions {
  /** When true, remove .env, orcy.db, and credentials.json instead of preserving them. */
  purge?: boolean;
  /** When true, skip all interactive prompts (set by `--yes` in the CLI). */
  yes?: boolean;
}

export async function uninstallAll(ctx: InstallContext, opts?: UninstallOptions): Promise<void> {
  // G9 step 1: warn on stale install journal (proceed against the manifest regardless).
  if (journalExists()) {
    console.warn(
      "    Warning: install journal found (interrupted install?). Proceeding with manifest-based uninstall.",
    );
  }

  // G9 step 2: read manifest (absent → exit).
  const manifest = readManifest();
  if (!manifest) {
    console.log("No install manifest found.");
    return;
  }

  console.log("==> Uninstalling orcy...");

  // B1: Stop + disable + bootout the running service BEFORE removing any files.
  // Without this the manifest loop deletes the unit/plist while the process is
  // still alive (launchd respawns via KeepAlive on macOS).
  try {
    stopLegacyService(ctx);
  } catch {}
  try {
    stopService(ctx);
  } catch {}
  try {
    uninstallService(ctx);
  } catch {}

  // Reverse order
  let hadFailure = false;
  const reversed = [...manifest.files].toReversed();
  for (const entry of reversed) {
    try {
      switch (entry.action) {
        case "created":
          if (fs.existsSync(entry.path)) {
            if (isModifiedSinceInstall(entry)) {
              console.warn(`    ${entry.path} changed since install — preserved, not removed`);
              break;
            }
            if (fs.statSync(entry.path).isDirectory()) {
              fs.rmSync(entry.path, { recursive: true });
            } else {
              fs.unlinkSync(entry.path);
            }
          }
          break;
        case "appended":
          if (fs.existsSync(entry.path)) {
            const content = fs.readFileSync(entry.path, "utf-8");
            const start = content.indexOf(SENTINEL_START);
            const end = content.indexOf(SENTINEL_END);
            if (start !== -1 && end !== -1) {
              const next = end + SENTINEL_END.length;
              fs.writeFileSync(
                entry.path,
                content.slice(0, start).trimEnd() + "\n" + content.slice(next).trimStart(),
              );
            }
          }
          break;
        case "fenced":
          removeFromFile(entry.path);
          break;
        case "merged-json": {
          const writer = ALL_WRITERS.find((w) => w.configPath === entry.path);
          if (writer) removeMcpConfig(writer);
          break;
        }
        case "copied":
          if (fs.existsSync(entry.path)) {
            if (isModifiedSinceInstall(entry)) {
              console.warn(`    ${entry.path} changed since install — preserved, not removed`);
              break;
            }
            if (fs.statSync(entry.path).isDirectory()) {
              fs.rmSync(entry.path, { recursive: true });
            } else {
              fs.unlinkSync(entry.path);
            }
          }
          break;
      }
    } catch (e) {
      hadFailure = true;
      console.warn(`    Could not remove ${entry.path}: ${e}`);
    }
  }

  // G4: Sweep disposable build artifacts not individually recorded in the
  // manifest. These are ephemeral — update re-fetches them on every run
  // (install-packages.ts:45). package.json is NOT swept: P3.2 hash-guards it
  // when recorded, or it is deliberately preserved for the user's deps.
  for (const dir of ["src", "cache", "node_modules"]) {
    const sweepPath = path.join(ctx.orcyHome, dir);
    if (fs.existsSync(sweepPath)) {
      try {
        fs.rmSync(sweepPath, { recursive: true });
        console.log(`    Swept ${dir}/`);
      } catch (e) {
        console.warn(`    Could not sweep ${dir}/: ${e}`);
      }
    }
  }

  removeShims(ctx);

  // G9 step 6: G5 consent-gated remote agent deactivation.
  // G9 step 7: D1 conditional preserve/remove of user data.
  const creds = readCredentials();
  const explicitPurge = opts?.purge ?? false;
  const interactive = process.stdin.isTTY === true && !opts?.yes;

  // Interactive: show the preserve-prompt (also surfaces G5 deactivation note
  // when an agent is registered).
  let willPurge = explicitPurge;
  if (interactive && !explicitPurge) {
    const { confirm } = await import("@clack/prompts");
    const message = creds
      ? `Also remove settings and data (.env, orcy.db, credentials)? This deactivates agent "${creds.agentName}" with the API.`
      : `Also remove settings and data (.env, orcy.db, credentials)?`;
    willPurge = (await confirm({ message, initialValue: false })) === true;
  }

  // G5: consent-gated remote DELETE.
  if (creds) {
    const consent = willPurge || interactive;
    if (consent) {
      try {
        const resp = await fetch(`${ctx.apiUrl}/api/agents/${creds.agentId}/self`, {
          method: "DELETE",
          headers: { "x-agent-api-key": creds.apiKey },
        });
        if (resp.ok) {
          console.log(`    Agent ${creds.agentId} deactivated.`);
        } else {
          console.warn(
            `    API deactivation returned ${resp.status}. Manual cleanup may be needed.`,
          );
        }
      } catch (e) {
        console.warn(
          `    Could not deactivate agent (API unreachable): ${e instanceof Error ? e.message : e}`,
        );
        console.warn(
          `    Manual: DELETE ${ctx.apiUrl}/api/agents/${creds.agentId}/self (header: x-agent-api-key)`,
        );
      }
    } else {
      // Non-interactive without explicit consent: skip, log orphan instructions.
      console.log(`    Agent ${creds.agentId} still registered. To deactivate manually:`);
      console.log(
        `    DELETE ${ctx.apiUrl}/api/agents/${creds.agentId}/self (header: x-agent-api-key: <key>)`,
      );
    }
  }

  // D1: purge or preserve user data files (.env, orcy.db, credentials.json).
  const dataFiles = [".env", "orcy.db", "credentials.json"];
  if (willPurge) {
    for (const f of dataFiles) {
      const fp = path.join(ctx.orcyHome, f);
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {}
    }
    console.log("    Removed: .env, orcy.db, credentials.json");
  } else {
    console.log("    Preserved: .env, orcy.db, credentials.json");
  }

  // G9 step 8: delete manifest LAST and ONLY on success (B4).
  if (!hadFailure) {
    const manifestPath = path.join(ctx.orcyHome, "install-manifest.json");
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  } else {
    console.log("    Some entries could not be removed. Manifest preserved for retry.");
  }

  console.log("    Uninstall complete.");
}

export function listInstall(_ctx: InstallContext): void {
  const manifest = readManifest();
  if (!manifest) {
    console.log("No install manifest found. Run `orcy-install` first.");
    return;
  }
  console.log(`Installed: ${manifest.components.join(", ")}`);
  console.log(`Installed at: ${manifest.installedAt}`);
  console.log("\nFiles managed:");
  for (const entry of manifest.files) {
    console.log(`  [${entry.action}] ${entry.path}`);
  }
}

export function serviceStatus(ctx: InstallContext): boolean {
  if (ctx.platform === "linux") {
    try {
      const out = execSync("systemctl --user is-active orcy-api", { encoding: "utf-8" }).trim();
      console.log(`Service status: ${out}`);
      return out === "active";
    } catch {
      console.log("Service status: inactive");
      return false;
    }
  }
  if (ctx.platform === "darwin") {
    try {
      const uid = execSync("id -u", { encoding: "utf-8" }).trim();
      const out = execSync(`launchctl print gui/${uid}/ai.orcy.api`, { encoding: "utf-8" }).trim();
      console.log(`Service status: ${out.includes("path") ? "active" : "inactive"}`);
      return out.includes("path");
    } catch {
      console.log("Service status: inactive");
      return false;
    }
  }
  console.log("No init system available");
  return false;
}
