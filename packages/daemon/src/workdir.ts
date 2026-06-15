import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { ClaimResult, WorkdirResult, WorkdirGcOptions } from "./types.js";
import { WorkdirError } from "@orcy/shared";
export { WorkdirError } from "@orcy/shared";

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;

function validateRepoPath(repoPath: string): string {
  if (!repoPath || typeof repoPath !== "string") {
    throw new WorkdirError("repoPath must be a non-empty string");
  }
  if (!repoPath.startsWith("/")) {
    throw new WorkdirError("repoPath must be an absolute path");
  }
  const resolved = resolve(repoPath);
  if (resolved !== repoPath.replace(/\/+$/, "")) {
    throw new WorkdirError("repoPath contains path traversal segments");
  }
  return resolved;
}

function validateBranchPrefix(prefix: string): string {
  if (!prefix || typeof prefix !== "string") {
    throw new WorkdirError("branchPrefix must be a non-empty string");
  }
  if (!SAFE_BRANCH_RE.test(prefix)) {
    throw new WorkdirError(
      "branchPrefix contains disallowed characters (only alphanumeric, dash, underscore, dot, slash allowed)",
    );
  }
  return prefix;
}

function validateWorktreeSettings(settings: NonNullable<ClaimResult["worktreeSettings"]>): {
  repoPath: string;
  branchPrefix: string;
} {
  const repoPath = validateRepoPath(settings.repoPath);
  const branchPrefix = validateBranchPrefix(settings.branchPrefix);
  return { repoPath, branchPrefix };
}

function computeWorktreePath(repoPath: string, taskId: string): string {
  const shortId = taskId.slice(0, 8);
  const parentDir = resolve(repoPath, "..");
  const worktreePath = join(parentDir, `task-${shortId}`);
  const resolved = resolve(worktreePath);
  if (!resolved.startsWith(parentDir + sep) && resolved !== parentDir) {
    throw new WorkdirError("generated worktree path escapes parent directory");
  }
  return resolved;
}

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function getWorkspacesBase(dataDir?: string): string {
  const base = dataDir ?? join(homedir(), ".orcy");
  return join(base, "workspaces");
}

export function createWorkdir(claim: ClaimResult, dataDir?: string): WorkdirResult {
  const settings = claim.worktreeSettings;
  if (!settings) {
    throw new WorkdirError(
      `Cannot create workdir: habitat has no gitWorktreeSettings for task ${claim.task.id}`,
    );
  }

  const { repoPath, branchPrefix } = validateWorktreeSettings(settings);
  const normalizedPrefix = branchPrefix.endsWith("/") ? branchPrefix : `${branchPrefix}/`;
  const branchName = `${normalizedPrefix}${claim.task.id}`;

  if (!SAFE_BRANCH_RE.test(branchName)) {
    throw new WorkdirError("generated branch name contains disallowed characters");
  }

  const worktreePath = computeWorktreePath(repoPath, claim.task.id);

  if (!existsSync(repoPath)) {
    throw new WorkdirError(`repoPath does not exist: ${repoPath}`);
  }

  try {
    try {
      gitExec(["worktree", "add", worktreePath, "-b", branchName], repoPath);
    } catch {
      gitExec(["worktree", "add", worktreePath, "-b", branchName, "--detach", "HEAD"], repoPath);
    }
  } catch {
    try {
      const listing = gitExec(["branch", "--list", branchName], repoPath).trim();
      if (listing) {
        gitExec(["worktree", "add", worktreePath, branchName], repoPath);
      } else {
        throw new WorkdirError(`Failed to create git worktree at ${worktreePath}`);
      }
    } catch (err) {
      throw new WorkdirError(
        `Failed to create git worktree: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const habitatDir = join(getWorkspacesBase(dataDir), claim.task.habitatId);
  if (!existsSync(habitatDir)) {
    mkdirSync(habitatDir, { recursive: true });
  }

  const linkPath = join(habitatDir, claim.task.id.slice(0, 8));
  try {
    writeFileSync(linkPath, worktreePath, "utf-8");
  } catch {}

  return {
    path: worktreePath,
    branch: branchName,
    worktreePath,
  };
}

export function validateWorktreeConfig(claim: ClaimResult): string | null {
  if (!claim.worktreeSettings) {
    return `Habitat ${claim.task.habitatId} has no gitWorktreeSettings configured`;
  }

  try {
    validateWorktreeSettings(claim.worktreeSettings);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (!existsSync(claim.worktreeSettings.repoPath)) {
    return `repoPath does not exist: ${claim.worktreeSettings.repoPath}`;
  }

  return null;
}

export function removeWorkdir(workdirPath: string, repoPath: string): boolean {
  try {
    try {
      gitExec(["worktree", "remove", workdirPath, "--force"], repoPath);
    } catch {
      if (existsSync(workdirPath)) {
        const parentDir = resolve(repoPath, "..");
        const resolved = resolve(workdirPath);
        if (resolved.startsWith(parentDir + sep) || resolved === parentDir) {
          rmSync(resolved, { recursive: true, force: true });
        }
      }
    }

    const branch = `task/${workdirPath.split("/").pop()?.replace("task-", "") ?? ""}`;
    try {
      if (SAFE_BRANCH_RE.test(branch)) {
        gitExec(["branch", "-D", branch], repoPath);
      }
    } catch {}

    return true;
  } catch {
    return false;
  }
}

export function gcWorkdirs(
  dataDir: string,
  options: WorkdirGcOptions = { retentionMs: 24 * 60 * 60 * 1000 },
): string[] {
  const base = getWorkspacesBase(dataDir);
  if (!existsSync(base)) return [];

  const now = options.now ?? Date.now();
  const removed: string[] = [];

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > options.retentionMs) {
            removed.push(fullPath);
            rmSync(fullPath, { force: true });
          }
        } catch {}
      }
    }
  }

  walk(base);
  return removed;
}
