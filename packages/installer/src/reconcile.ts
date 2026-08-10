import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import type { InstallContext } from "./context.js";

/**
 * Reconcile a v1 (or versionless) install manifest to v2 (design §7 G11).
 *
 * On the first new-installer run against an existing `~/.orcy/` carrying a v1
 * manifest, this rebuilds a complete v2 manifest in place:
 *   1. Rewrite stale `~/.kanban/...` entry paths → `~/.orcy/...` (handles paths
 *      left by a pre-P6.1 migrate, so uninstall actually finds the files).
 *   2. Dedup `files[]` on `{path, action}` (collapses duplicates from pre-P1.1
 *      installs, mirroring `record()`'s manifest dedup).
 *   3. Bump `version` to 2.
 *
 * Footprint dirs (`src`/`cache`/`node_modules`) are logged informationally but
 * NOT added to `files[]` — they are swept wholesale on uninstall (G4), not
 * tracked individually; adding them would contradict the G4 model.
 *
 * Commit gate: interactive → confirm prompt (decline leaves the manifest
 * unchanged); non-interactive → auto-apply with a log (reconcile only
 * fixes/dedups/rewrites — it never deletes user data).
 *
 * Returns `true` if the manifest was reconciled, `false` if there was nothing to
 * do (no manifest, or already at version ≥ 2).
 */
export async function reconcileManifest(
  ctx: InstallContext,
  opts: { interactive: boolean },
): Promise<boolean> {
  const manifest = readManifest();
  // No install → nothing to reconcile. Already current → no-op.
  if (!manifest) return false;
  if ((manifest.version ?? 1) >= 2) return false;

  const legacy = path.join(os.homedir(), ".kanban");
  let pathCount = 0;
  let dupCount = 0;

  // 1. Path rewrite — ~/.kanban → ~/.orcy. Separator-aware so a sibling like
  // ~/.kanban-notes is NOT rewritten to ~/.orcy-notes (T2.1).
  for (const entry of manifest.files) {
    if (entry.path === legacy || entry.path.startsWith(legacy + path.sep)) {
      entry.path = ctx.orcyHome + entry.path.slice(legacy.length);
      pathCount++;
    }
  }

  // 2. Dedup on {path, action} (post-rewrite, so equivalent paths collapse).
  const seen = new Set<string>();
  const deduped: Manifest["files"] = [];
  for (const entry of manifest.files) {
    const key = `${entry.path}\0${entry.action}`;
    if (seen.has(key)) {
      dupCount++;
    } else {
      seen.add(key);
      deduped.push(entry);
    }
  }
  manifest.files = deduped;

  // 3. Footprint accounting (informational only — not added to files[]).
  const footprint: string[] = [];
  for (const dir of ["src", "cache", "node_modules"]) {
    if (fs.existsSync(path.join(ctx.orcyHome, dir))) footprint.push(dir);
  }

  // 4. Version bump.
  manifest.version = 2;

  const summary =
    `v1→v2 reconcile: ${dupCount} duplicate(s) removed, ${pathCount} path(s) rewritten` +
    (footprint.length ? `, footprint present: ${footprint.join(", ")}` : "");

  if (opts.interactive) {
    const { confirm } = await import("@clack/prompts");
    const ok = await confirm({
      message: `Reconcile your install manifest to v2? (${summary})`,
      initialValue: true,
    });
    if (!ok) {
      console.log("    Reconcile declined — manifest left unchanged.");
      return false;
    }
  } else {
    console.log(`    ${summary}`);
  }

  writeManifest(manifest);
  console.log("    Manifest reconciled to v2.");
  return true;
}
