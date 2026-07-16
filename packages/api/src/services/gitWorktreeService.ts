import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import * as path from "path";
import * as habitatRepo from "../repositories/habitat.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import type { GitWorktreeSettings } from "../models/index.js";
import { logger } from "../lib/logger.js";

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;
const ABSOLUTE_PATH_RE = /^\//;

const activeWorktrees = new Map<string, { path: string; branch: string; repoRoot: string }>();

/** Error thrown when worktree inputs (repo path, branch name, generated paths) fail validation. */
export class WorktreeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeValidationError";
  }
}

/** Validates that a repo path is absolute and free of traversal segments, returning it with trailing slashes trimmed. */
export function validateRepoPath(repoPath: string): string {
  if (!repoPath || typeof repoPath !== "string") {
    throw new WorktreeValidationError("repoPath must be a non-empty string");
  }
  if (!ABSOLUTE_PATH_RE.test(repoPath)) {
    throw new WorktreeValidationError("repoPath must be an absolute path");
  }
  const resolved = path.resolve(repoPath);
  if (resolved !== repoPath.replace(/\/+$/, "")) {
    throw new WorktreeValidationError("repoPath contains path traversal segments");
  }
  return repoPath.replace(/\/+$/, "");
}

/** Validates that a branch prefix contains only git-safe characters, returning it unchanged. */
export function validateBranchPrefix(prefix: string): string {
  if (!prefix || typeof prefix !== "string") {
    throw new WorktreeValidationError("branchPrefix must be a non-empty string");
  }
  if (!SAFE_BRANCH_RE.test(prefix)) {
    throw new WorktreeValidationError(
      "branchPrefix contains disallowed characters (only alphanumeric, dash, underscore, dot, slash allowed)",
    );
  }
  return prefix;
}

function validateBranchName(name: string): void {
  if (!name || !SAFE_BRANCH_RE.test(name)) {
    throw new WorktreeValidationError("branch name contains disallowed characters");
  }
}

function computeWorktreePath(repoPath: string, taskId: string): string {
  const shortId = taskId.slice(0, 8);
  const parentDir = path.resolve(repoPath, "..");
  const worktreePath = path.join(parentDir, `task-${shortId}`);
  const resolved = path.resolve(worktreePath);
  if (!resolved.startsWith(parentDir + path.sep) && resolved !== parentDir) {
    throw new WorktreeValidationError("generated worktree path escapes parent directory");
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

function safeDeletePath(targetPath: string, allowedParent: string): void {
  const resolved = path.resolve(targetPath);
  const parent = path.resolve(allowedParent);
  if (!resolved.startsWith(parent + path.sep) && resolved !== parent) {
    throw new WorktreeValidationError("refusing to delete path outside allowed parent");
  }
  if (existsSync(resolved)) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

function resolveSettings(settings: GitWorktreeSettings) {
  const repoPath = validateRepoPath(settings.repoPath);
  validateBranchPrefix(settings.branchPrefix);
  return { repoPath };
}

/** Creates a git worktree and dedicated branch for a task from the habitat's worktree settings, caching and returning the entry. Returns null when worktrees are disabled or creation fails. */
export function createWorktree(
  taskId: string,
  habitatId: string,
): { path: string; branch: string; repoRoot: string } | null {
  const existing = activeWorktrees.get(taskId);
  if (existing) return existing;

  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat?.gitWorktreeSettings) return null;

  const settings = habitat.gitWorktreeSettings;
  let repoPath: string;
  try {
    repoPath = resolveSettings(settings).repoPath;
  } catch {
    return null;
  }

  const branchName = `${settings.branchPrefix}/${taskId}`;
  try {
    validateBranchName(branchName);
  } catch {
    return null;
  }

  let worktreePath: string;
  try {
    worktreePath = computeWorktreePath(repoPath, taskId);
  } catch {
    return null;
  }

  try {
    try {
      gitExec(["worktree", "add", worktreePath, "-b", branchName], repoPath);
    } catch {
      gitExec(["worktree", "add", worktreePath, "-b", branchName, "--detach", "HEAD"], repoPath);
    }

    const entry = { path: worktreePath, branch: branchName, repoRoot: repoPath };
    activeWorktrees.set(taskId, entry);
    return entry;
  } catch (err) {
    logger.warn({ err, taskId, branchName, worktreePath }, "Git worktree creation failed");
    try {
      const listing = gitExec(["branch", "--list", branchName], repoPath).trim();
      if (listing) {
        gitExec(["worktree", "add", worktreePath, branchName], repoPath);
        const entry = { path: worktreePath, branch: branchName, repoRoot: repoPath };
        activeWorktrees.set(taskId, entry);
        return entry;
      }
    } catch (fallbackErr) {
      logger.warn(
        { err: fallbackErr, branchName, repoPath },
        "Failed fallback worktree creation from existing branch",
      );
    }

    return null;
  }
}

/** Tears down a task's worktree directory and deletes its branch, returning whether cleanup succeeded. */
export function removeWorktree(taskId: string): boolean {
  const entry = activeWorktrees.get(taskId);
  if (!entry) return false;

  const parentDir = path.resolve(entry.repoRoot, "..");

  try {
    try {
      gitExec(["worktree", "remove", entry.path, "--force"], entry.repoRoot);
    } catch {
      safeDeletePath(entry.path, parentDir);
    }

    try {
      validateBranchName(entry.branch);
      gitExec(["branch", "-D", entry.branch], entry.repoRoot);
    } catch (err) {
      logger.warn({ err, branch: entry.branch }, "Failed to delete worktree branch during cleanup");
    }

    activeWorktrees.delete(taskId);
    return true;
  } catch (err) {
    logger.warn({ err, taskId }, "Git worktree removal failed");
    activeWorktrees.delete(taskId);
    return false;
  }
}

/** Returns the cached or on-disk worktree entry for a task, lazily resolving and caching it from habitat settings when present. */
export function getWorktreeInfo(
  taskId: string,
): { path: string; branch: string; repoRoot: string } | null {
  const entry = activeWorktrees.get(taskId);
  if (entry) return entry;

  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;

  const habitatId = getHabitatIdForTask(taskId);
  if (!habitatId) return null;

  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat?.gitWorktreeSettings) return null;

  const settings = habitat.gitWorktreeSettings;
  let repoPath: string;
  try {
    repoPath = resolveSettings(settings).repoPath;
  } catch {
    return null;
  }

  const branchName = `${settings.branchPrefix}/${taskId}`;
  let worktreePath: string;
  try {
    worktreePath = computeWorktreePath(repoPath, taskId);
  } catch {
    return null;
  }

  try {
    if (!existsSync(worktreePath)) return null;
    gitExec(["rev-parse", "--git-dir"], worktreePath);
    const resolvedEntry = { path: worktreePath, branch: branchName, repoRoot: settings.repoPath };
    activeWorktrees.set(taskId, resolvedEntry);
    return resolvedEntry;
  } catch {
    return null;
  }
}

/** Clears the in-memory worktree cache; intended for resetting state between tests. */
export function _resetActiveWorktrees(): void {
  activeWorktrees.clear();
}

/** Returns whether the habitat has git worktree settings configured. */
export function isWorktreeEnabled(habitatId: string): boolean {
  const habitat = habitatRepo.getHabitatById(habitatId);
  return !!habitat?.gitWorktreeSettings;
}

/** Returns the habitat's git worktree settings, or null when worktrees are not configured. */
export function getWorktreeSettings(habitatId: string): GitWorktreeSettings | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  return habitat?.gitWorktreeSettings ?? null;
}
