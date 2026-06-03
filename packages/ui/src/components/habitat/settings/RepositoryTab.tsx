import React, { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../ui/Button.js";
import { Badge } from "../../ui/Badge.js";
import { notify } from "../../../lib/toast.js";
import { api } from "../../../api/index.js";
import { queryKeys } from "../../../lib/queryKeys.js";
import type { CodeEvidenceVerificationState } from "../../../types/index.js";
import { GitBranch, RefreshCw, Cloud, Loader2 } from "lucide-react";

export interface RepositoryTabHandle {
  save: () => Promise<void>;
}

interface RepositoryTabProps {
  habitatId: string;
  onSavingChange: (saving: boolean) => void;
}

const INPUT_CLASS =
  "w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary";

const VERIFICATION_BADGE_VARIANT: Record<
  CodeEvidenceVerificationState,
  "approved" | "failed" | "pending" | "default"
> = {
  verified: "approved",
  unverified: "pending",
  stale: "pending",
  failed: "failed",
};

export const RepositoryTab = forwardRef<RepositoryTabHandle, RepositoryTabProps>(
  function RepositoryTab({ habitatId, onSavingChange }, ref) {
    const queryClient = useQueryClient();
    const repoQueryKey = queryKeys.codeEvidence.repository(habitatId);

    const {
      data: repoData,
      isLoading,
      isError,
      error,
      refetch,
      isFetching,
    } = useQuery({
      queryKey: repoQueryKey,
      queryFn: () => api.codeEvidence.getRepository(habitatId),
    });

    const repo = repoData?.repository ?? null;

    const [provider, setProvider] = useState("");
    const [providerBaseUrl, setProviderBaseUrl] = useState("");
    const [repoSlug, setRepoSlug] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [localPath, setLocalPath] = useState("");
    const [saving, setSaving] = useState(false);
    const [inferring, setInferring] = useState<"worktree" | "integration" | null>(null);
    const [verificationState, setVerificationState] =
      useState<CodeEvidenceVerificationState | null>(null);

    useEffect(() => {
      onSavingChange(saving);
    }, [saving, onSavingChange]);

    useEffect(() => {
      if (repo) {
        setProvider(repo.provider ?? "");
        setProviderBaseUrl(repo.providerBaseUrl ?? "");
        setRepoSlug(repo.repoSlug ?? "");
        setDisplayName(repo.displayName ?? "");
        setLocalPath(repo.localPath ?? "");
        setVerificationState(repo.verificationState);
      } else {
        setProvider("");
        setProviderBaseUrl("");
        setRepoSlug("");
        setDisplayName("");
        setLocalPath("");
        setVerificationState(null);
      }
    }, [repo]);

    const handleSave = useCallback(async () => {
      setSaving(true);
      try {
        const result = await api.codeEvidence.updateRepository(habitatId, {
          provider: provider || undefined,
          providerBaseUrl: providerBaseUrl.trim() || undefined,
          repoSlug: repoSlug.trim() || undefined,
          displayName: displayName.trim() || undefined,
          localPath: localPath.trim() || undefined,
        });
        setVerificationState(result.repository.verificationState);
        await queryClient.invalidateQueries({ queryKey: repoQueryKey });
        notify.success("Repository identity saved");
      } catch (err: any) {
        notify.error(err?.message ?? "Failed to save repository identity");
        throw err;
      } finally {
        setSaving(false);
      }
    }, [
      habitatId,
      provider,
      providerBaseUrl,
      repoSlug,
      displayName,
      localPath,
      queryClient,
      repoQueryKey,
    ]);

    useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

    const handleInferFromWorktree = async () => {
      if (inferring) return;
      setInferring("worktree");
      try {
        await api.codeEvidence.inferFromWorktree(habitatId);
        await queryClient.invalidateQueries({ queryKey: repoQueryKey });
        notify.success("Repository identity inferred from worktree");
      } catch (err: any) {
        notify.error(err?.message ?? "Failed to infer from worktree");
      } finally {
        setInferring(null);
      }
    };

    const handleInferFromIntegration = async () => {
      if (inferring) return;
      setInferring("integration");
      try {
        await api.codeEvidence.inferFromIntegration(habitatId);
        await queryClient.invalidateQueries({ queryKey: repoQueryKey });
        notify.success("Repository identity inferred from integration");
      } catch (err: any) {
        notify.error(err?.message ?? "Failed to infer from integration");
      } finally {
        setInferring(null);
      }
    };

    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (isError) {
      return (
        <div className="space-y-4 rounded border border-destructive/30 bg-destructive/5 p-4">
          <div>
            <h3 className="text-sm font-medium text-destructive">
              Repository settings failed to load
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {error instanceof Error ? error.message : "Unable to load repository identity."}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Retry
          </Button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Configure the repository identity used for code evidence provenance tracking.
        </p>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleInferFromWorktree}
            disabled={saving || inferring !== null}
          >
            {inferring === "worktree" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="mr-1.5 h-3.5 w-3.5" />
            )}
            Infer from Worktree
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleInferFromIntegration}
            disabled={saving || inferring !== null}
          >
            {inferring === "integration" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="mr-1.5 h-3.5 w-3.5" />
            )}
            Infer from Integration
          </Button>
        </div>

        <div>
          <label htmlFor="repo-provider" className="mb-1 block text-sm font-medium">
            Provider
          </label>
          <select
            id="repo-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">Select provider</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="local">Local</option>
          </select>
        </div>

        <div>
          <label htmlFor="repo-base-url" className="mb-1 block text-sm font-medium">
            Provider Base URL
          </label>
          <input
            id="repo-base-url"
            type="text"
            value={providerBaseUrl}
            onChange={(e) => setProviderBaseUrl(e.target.value)}
            placeholder="https://github.com (optional)"
            className={INPUT_CLASS}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Override the default provider URL for self-hosted instances.
          </p>
        </div>

        <div>
          <label htmlFor="repo-slug" className="mb-1 block text-sm font-medium">
            Repository Slug
          </label>
          <input
            id="repo-slug"
            type="text"
            value={repoSlug}
            onChange={(e) => setRepoSlug(e.target.value)}
            placeholder="org/repo"
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor="repo-display-name" className="mb-1 block text-sm font-medium">
            Display Name
          </label>
          <input
            id="repo-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My Project (optional)"
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor="repo-local-path" className="mb-1 block text-sm font-medium">
            Local Path
          </label>
          <input
            id="repo-local-path"
            type="text"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/path/to/repo (optional)"
            className={INPUT_CLASS}
          />
        </div>

        {verificationState && (
          <div>
            <label className="mb-1 block text-sm font-medium">Verification State</label>
            <Badge variant={VERIFICATION_BADGE_VARIANT[verificationState]}>
              {verificationState}
            </Badge>
          </div>
        )}
      </div>
    );
  },
);
