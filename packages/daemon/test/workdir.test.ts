import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { validateWorktreeConfig, createWorkdir, gcWorkdirs, WorkdirError } =
  await import("../src/workdir.js");

interface ClaimResultLike {
  task: {
    id: string;
    title: string;
    description: string | null;
    missionId: string;
    habitatId: string;
    priority: string;
    requiredDomain: string | null;
    requiredCapabilities: string[] | null;
  };
  worktreeSettings: {
    repoPath: string;
    branchPrefix: string;
    autoCleanup: boolean;
  } | null;
}

function makeClaim(repoPath = "/tmp/test-repo"): ClaimResultLike {
  return {
    task: {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      title: "Test task",
      description: "desc",
      missionId: "mission-1",
      habitatId: "habitat-1",
      priority: "high",
      requiredDomain: null,
      requiredCapabilities: [],
    },
    worktreeSettings: {
      repoPath,
      branchPrefix: "task/",
      autoCleanup: true,
    },
  };
}

describe("workdir", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orcy-workdir-test-"));
    repoDir = join(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("validateWorktreeConfig", () => {
    it("returns error when worktreeSettings is null", () => {
      const claim = makeClaim();
      claim.worktreeSettings = null;
      expect(validateWorktreeConfig(claim as any)).toContain("no gitWorktreeSettings");
    });

    it("returns error for relative repoPath", () => {
      const claim = makeClaim();
      claim.worktreeSettings = {
        repoPath: "relative/path",
        branchPrefix: "task/",
        autoCleanup: true,
      };
      expect(validateWorktreeConfig(claim as any)).toContain("absolute path");
    });

    it("returns error for empty branchPrefix", () => {
      const claim = makeClaim();
      claim.worktreeSettings = {
        repoPath: "/tmp/repo",
        branchPrefix: "",
        autoCleanup: true,
      };
      expect(validateWorktreeConfig(claim as any)).toContain("non-empty string");
    });

    it("returns error for disallowed branchPrefix chars", () => {
      const claim = makeClaim();
      claim.worktreeSettings = {
        repoPath: "/tmp/repo",
        branchPrefix: "bad;rm -rf",
        autoCleanup: true,
      };
      expect(validateWorktreeConfig(claim as any)).toContain("disallowed characters");
    });
  });

  describe("createWorkdir", () => {
    it("throws WorkdirError when worktreeSettings is null", () => {
      const claim = makeClaim();
      claim.worktreeSettings = null;
      expect(() => createWorkdir(claim as any)).toThrow(WorkdirError);
    });

    it("throws WorkdirError for invalid branchPrefix", () => {
      const claim = makeClaim();
      claim.worktreeSettings = {
        repoPath: repoDir,
        branchPrefix: "bad;prefix",
        autoCleanup: true,
      };
      expect(() => createWorkdir(claim as any)).toThrow(WorkdirError);
    });

    it("creates worktree using git worktree add", () => {
      const claim = makeClaim(repoDir);
      execFileSyncMock.mockReturnValue("");

      const result = createWorkdir(claim as any, tempDir);

      expect(result.branch).toBe("task/01234567-89ab-cdef-0123-456789abcdef");
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "add"]),
        expect.any(Object),
      );
    });

    it("falls back when initial worktree add fails", () => {
      const claim = makeClaim(repoDir);
      let callCount = 0;
      execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
        callCount++;
        if (args?.[0] === "worktree" && callCount === 1) {
          throw new Error("already exists");
        }
        if (args?.[0] === "worktree" && callCount === 2) return "";
        if (args?.[0] === "branch") {
          return "  task/01234567-89ab-cdef-0123-456789abcdef";
        }
        return "";
      });

      const result = createWorkdir(claim as any, tempDir);
      expect(result.branch).toContain("task/");
    });

    it("throws WorkdirError when git worktree add fails completely", () => {
      const claim = makeClaim(repoDir);
      execFileSyncMock.mockImplementation(() => {
        throw new Error("git failed");
      });

      expect(() => createWorkdir(claim as any, tempDir)).toThrow(WorkdirError);
    });
  });

  describe("gcWorkdirs", () => {
    it("removes files older than retention period", () => {
      const wsDir = join(tempDir, "workspaces", "hab-1");
      mkdirSync(wsDir, { recursive: true });
      const oldFile = join(wsDir, "abc12345");
      writeFileSync(oldFile, "/some/path", "utf-8");

      const result = gcWorkdirs(tempDir, {
        retentionMs: 1000,
        now: Date.now() + 100000,
      });

      expect(result).toContain(oldFile);
    });

    it("keeps files newer than retention period", () => {
      const wsDir = join(tempDir, "workspaces", "hab-1");
      mkdirSync(wsDir, { recursive: true });
      const newFile = join(wsDir, "abc12345");
      writeFileSync(newFile, "/some/path", "utf-8");

      const result = gcWorkdirs(tempDir, {
        retentionMs: 24 * 60 * 60 * 1000,
        now: Date.now(),
      });

      expect(result).toEqual([]);
    });
  });
});
