import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { ToggleSwitch } from "../../ui/ToggleSwitch.js";
import { useHabitatSettingsSaver } from "../../../hooks/useHabitatSettingsSaver.js";
import type { PublicHabitat, GitWorktreeSettings } from "../../../types/index.js";

interface WorktreeTabProps {
  habitatId: string;
  boardGitWorktreeSettings: GitWorktreeSettings | null;
  onUpdate: (habitat: PublicHabitat) => void;
  onSavingChange?: (saving: boolean) => void;
}

export interface WorktreeTabHandle {
  save: () => Promise<void>;
}

export const WorktreeTab = forwardRef<WorktreeTabHandle, WorktreeTabProps>(function WorktreeTab(
  { habitatId, boardGitWorktreeSettings, onUpdate, onSavingChange },
  ref,
) {
  const [repoPath, setRepoPath] = useState("");
  const [branchPrefix, setBranchPrefix] = useState("orcy/");
  const [autoCleanup, setAutoCleanup] = useState(true);

  const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId: habitatId, onUpdate });

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  useEffect(() => {
    if (boardGitWorktreeSettings) {
      setRepoPath(boardGitWorktreeSettings.repoPath ?? "");
      setBranchPrefix(boardGitWorktreeSettings.branchPrefix ?? "orcy/");
      setAutoCleanup(boardGitWorktreeSettings.autoCleanup !== false);
    } else {
      setRepoPath("");
      setBranchPrefix("orcy/");
      setAutoCleanup(true);
    }
  }, [boardGitWorktreeSettings]);

  const handleSave = useCallback(async () => {
    const trimmed = repoPath.trim();
    if (!trimmed) {
      await saveSettings({ gitWorktreeSettings: null }, "Worktree settings disabled");
      return;
    }
    await saveSettings(
      {
        gitWorktreeSettings: {
          repoPath: trimmed,
          branchPrefix: branchPrefix.trim() || "orcy/",
          autoCleanup,
        },
      },
      "Worktree settings saved",
    );
  }, [saveSettings, repoPath, branchPrefix, autoCleanup]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Configure where the daemon creates git worktrees for autonomous sessions.
      </p>
      <div>
        <label htmlFor="worktree-repo-path" className="mb-1 block text-sm font-medium">
          Repository Path
        </label>
        <input
          id="worktree-repo-path"
          type="text"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="/path/to/your/repo"
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Absolute path to the git repository where worktrees will be created.
        </p>
      </div>
      <div>
        <label htmlFor="worktree-branch-prefix" className="mb-1 block text-sm font-medium">
          Branch Prefix
        </label>
        <input
          id="worktree-branch-prefix"
          type="text"
          value={branchPrefix}
          onChange={(e) => setBranchPrefix(e.target.value)}
          placeholder="orcy/"
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Prefix for branches created by the daemon. Defaults to <code>orcy/</code>.
        </p>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p id="worktree-auto-cleanup-label" className="text-sm font-medium">
            Auto Cleanup
          </p>
          <p className="text-xs text-muted-foreground">
            Remove worktree directories after sessions complete.
          </p>
        </div>
        <ToggleSwitch
          checked={autoCleanup}
          onChange={(val) => setAutoCleanup(val)}
          aria-labelledby="worktree-auto-cleanup-label"
        />
      </div>
    </div>
  );
});
