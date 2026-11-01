/**
 * Remove the run root supplied by this harness's internal FullConfig metadata,
 * never an environment path. The tmpdir/prefix check is defense in depth, not
 * proof of ownership for arbitrary caller-supplied metadata. Failed cleanup is
 * left to the OS temp cleaner rather than broadening the deletion target.
 */
import type { FullConfig } from "@playwright/test";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUN_ROOT_PREFIX } from "./seeded.harness.constants.ts";

export default async function globalTeardown(config: FullConfig): Promise<void> {
  const root = config.metadata?.runRoot;
  if (typeof root !== "string" || root === "") return; // worker-shaped config: nothing to clean

  const parent = path.dirname(root);
  const base = path.basename(root);
  if (
    parent !== tmpdir() ||
    !base.startsWith(RUN_ROOT_PREFIX) ||
    base.length <= RUN_ROOT_PREFIX.length
  ) {
    // Refuse: not the exact mkdtemp shape this harness allocated. Never delete.
    console.log(`[seeded-e2e] teardown REFUSED non-owned path: ${root}`);
    return;
  }
  try {
    if (!statSync(root).isDirectory()) {
      console.log(`[seeded-e2e] teardown REFUSED non-directory: ${root}`);
      return;
    }
  } catch {
    return; // already gone — nothing to clean
  }

  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    console.log(`[seeded-e2e] cleaned run root: ${root}`);
  } catch (err) {
    console.log(`[seeded-e2e] left run root for OS temp cleanup: ${root} (${String(err)})`);
  }
}
