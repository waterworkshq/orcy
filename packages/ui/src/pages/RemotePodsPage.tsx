import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useRemoteAccessManagement,
  useRevokeGrant,
  useUpdateParticipant,
  useInvalidateRemoteAccess,
} from "../lib/useHabitatData.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.js";
import { Badge } from "../components/ui/Badge.js";
import { notify } from "../lib/toast.js";
import { ArrowLeft, Globe, Loader2, Shield, Key, Users, Award, AlertCircle } from "lucide-react";
import type {
  RemoteAccessManagementView,
  RemotePodView,
  RemoteParticipantView,
  RemoteGrantView,
} from "../types/index.js";

export function RemotePodsPage() {
  const { habitatId } = useParams<{ habitatId: string }>();
  const managementQuery = useRemoteAccessManagement(habitatId);

  if (!habitatId) {
    return (
      <div className="flex items-center justify-center py-20 text-[var(--on-surface-variant)]">
        No habitat selected.
      </div>
    );
  }

  if (managementQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--primary)]" />
      </div>
    );
  }

  if (managementQuery.error || !managementQuery.data) {
    return (
      <div className="max-w-2xl mx-auto py-10 px-4">
        <Card>
          <CardContent className="py-10 text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-red-500 mb-3" />
            <p className="text-sm text-[var(--on-surface-variant)]">
              Failed to load remote access data.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const view = managementQuery.data as RemoteAccessManagementView;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <div className="sticky top-0 z-10 glass-panel border-b border-[var(--outline-variant)] px-4 py-3 flex items-center gap-3">
        <Link to={`/habitats/${habitatId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Globe className="h-5 w-5 text-orange-500" />
          Remote Pods
        </h1>
        <div className="ml-auto flex items-center gap-3 text-xs text-[var(--on-surface-variant)]">
          <span>{view.summary.activePods} active pods</span>
          <span>·</span>
          <span>{view.summary.activeParticipants} participants</span>
          <span>·</span>
          <span>{view.summary.activeGrants} grants</span>
        </div>
      </div>

      <div className="max-w-5xl mx-auto py-6 px-4 space-y-6">
        {view.pods.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Globe className="mx-auto h-10 w-10 text-[var(--on-surface-variant)] mb-3" />
              <p className="text-sm text-[var(--on-surface-variant)]">
                No remote pods connected to this habitat yet.
              </p>
              <p className="text-xs text-[var(--on-surface-variant)] mt-1">
                Use the Share Habitat flow to invite a remote pod.
              </p>
            </CardContent>
          </Card>
        ) : (
          view.pods.map((pod) => (
            <RemotePodSection
              key={pod.id}
              pod={pod}
              participants={view.participants.filter((p) => p.remotePodId === pod.id)}
              grants={view.grants.filter((g) => g.remotePodId === pod.id)}
              habitatId={habitatId}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RemotePodSection({
  pod,
  participants,
  grants,
  habitatId,
}: {
  pod: RemotePodView;
  participants: RemoteParticipantView[];
  grants: RemoteGrantView[];
  habitatId: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-orange-500" />
            {pod.name}
          </CardTitle>
          <p className="text-xs text-[var(--on-surface-variant)] mt-1">
            {pod.description || "No description"}
          </p>
        </div>
        <Badge variant={pod.status === "active" ? "done" : "pending"}>{pod.status}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <span className="text-[var(--on-surface-variant)]">Default Standing</span>
            <p className="font-medium">{pod.defaultStanding}</p>
          </div>
          <div>
            <span className="text-[var(--on-surface-variant)]">Provider</span>
            <p className="font-medium">{pod.providerPodIdentity ?? "—"}</p>
          </div>
          <div>
            <span className="text-[var(--on-surface-variant)]">Participants</span>
            <p className="font-medium">{participants.length}</p>
          </div>
          <div>
            <span className="text-[var(--on-surface-variant)]">Active Grants</span>
            <p className="font-medium">{grants.filter((g) => g.status === "active").length}</p>
          </div>
        </div>

        {participants.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-2 flex items-center gap-1">
              <Users className="h-3 w-3" /> Participants
            </h4>
            <div className="space-y-2">
              {participants.map((p) => (
                <RemoteParticipantRow key={p.id} participant={p} habitatId={habitatId} />
              ))}
            </div>
          </div>
        )}

        {grants.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-2 flex items-center gap-1">
              <Award className="h-3 w-3" /> Grants
            </h4>
            <div className="space-y-2">
              {grants.map((g) => (
                <RemoteGrantRow key={g.id} grant={g} habitatId={habitatId} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RemoteParticipantRow({
  participant,
  habitatId,
}: {
  participant: RemoteParticipantView;
  habitatId: string;
}) {
  const updateParticipant = useUpdateParticipant(habitatId);
  const invalidate = useInvalidateRemoteAccess();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const handleAction = (action: "activate" | "suspend" | "revoke") => {
    updateParticipant.mutate(
      { participantId: participant.id, body: { action } },
      {
        onSuccess: () => {
          notify.success(`Participant ${action}d`);
          invalidate(habitatId);
        },
        onError: (err) => notify.error(`Failed: ${(err as Error).message}`),
      },
    );
    setConfirmRevoke(false);
  };

  return (
    <div className="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-container-low)]">
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold ${
            participant.participantType === "remote_human"
              ? "bg-orange-500/15 text-orange-600"
              : "bg-teal-500/15 text-teal-600"
          }`}
        >
          {participant.participantType === "remote_human" ? "RH" : "RO"}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{participant.displayName}</p>
          <div className="flex items-center gap-2 text-[10px] text-[var(--on-surface-variant)]">
            <Badge variant="default" className="text-[9px] py-0 px-1">
              {participant.standing}
            </Badge>
            {participant.hasActiveCredential && (
              <span className="flex items-center gap-0.5">
                <Key className="h-2.5 w-2.5" /> credential
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Badge
          variant={participant.status === "active" ? "done" : "pending"}
          className="text-[9px]"
        >
          {participant.status}
        </Badge>
        {participant.status === "active" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px]"
            disabled={updateParticipant.isPending}
            onClick={() => handleAction("suspend")}
          >
            Suspend
          </Button>
        )}
        {participant.status === "suspended" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px]"
            disabled={updateParticipant.isPending}
            onClick={() => handleAction("activate")}
          >
            Activate
          </Button>
        )}
        {participant.status !== "revoked" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] text-red-500"
            disabled={updateParticipant.isPending}
            onClick={() => setConfirmRevoke(true)}
          >
            Revoke
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmRevoke}
        onCancel={() => setConfirmRevoke(false)}
        title="Revoke participant?"
        description={`This will revoke ${participant.displayName}. They will lose all access immediately.`}
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={() => handleAction("revoke")}
      />
    </div>
  );
}

function RemoteGrantRow({ grant, habitatId }: { grant: RemoteGrantView; habitatId: string }) {
  const revokeGrant = useRevokeGrant(habitatId);
  const invalidate = useInvalidateRemoteAccess();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const handleRevoke = (mode: "soft" | "hard" | "freeze") => {
    revokeGrant.mutate(
      { grantId: grant.id, mode },
      {
        onSuccess: () => {
          notify.success(`Grant ${mode} revoked`);
          invalidate(habitatId);
        },
        onError: (err) => notify.error(`Failed: ${(err as Error).message}`),
      },
    );
    setConfirmRevoke(false);
  };

  const standingBadge = grant.standing === "remote_contributor" ? "done" : "medium";
  const statusBadge =
    grant.status === "active" ? "done" : grant.status === "expired" ? "pending" : "rejected";

  return (
    <div className="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-container-low)]">
      <div className="flex items-center gap-2 min-w-0">
        <Shield className="h-3.5 w-3.5 text-[var(--on-surface-variant)]" />
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {grant.grantType === "baseline_observer"
              ? "Baseline Observer"
              : grant.grantType === "scoped_elevation"
                ? "Scoped Elevation"
                : grant.grantType === "permanent_execution"
                  ? "Permanent Execution"
                  : grant.grantType}
            {grant.isPodWide && (
              <span className="ml-1 text-[10px] text-orange-500 font-normal">(pod-wide)</span>
            )}
            {grant.isPermanent && (
              <span className="ml-1 text-[10px] text-red-500 font-normal">(permanent)</span>
            )}
          </p>
          <div className="flex items-center gap-2 text-[10px] text-[var(--on-surface-variant)]">
            <Badge variant={standingBadge as "done" | "medium"} className="text-[9px] py-0 px-1">
              {grant.standing}
            </Badge>
            <span>scopes: {grant.actionScopes.join(", ")}</span>
            {grant.expiresAt && (
              <span>· expires {new Date(grant.expiresAt).toLocaleDateString()}</span>
            )}
            {grant.graceWindowHours > 0 && <span>· {grant.graceWindowHours}h grace</span>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Badge variant={statusBadge as "done" | "pending" | "rejected"} className="text-[9px]">
          {grant.status}
        </Badge>
        {grant.status === "active" && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px]"
              disabled={revokeGrant.isPending}
              onClick={() => handleRevoke("soft")}
            >
              Soft Revoke
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] text-red-500"
              disabled={revokeGrant.isPending}
              onClick={() => setConfirmRevoke(true)}
            >
              Hard Revoke
            </Button>
            <ConfirmDialog
              open={confirmRevoke}
              onCancel={() => setConfirmRevoke(false)}
              title="Hard revoke grant?"
              description="This will immediately block ALL remote actions for this grant and release any claimed tasks."
              confirmLabel="Hard Revoke"
              variant="danger"
              onConfirm={() => handleRevoke("hard")}
            />
          </>
        )}
      </div>
    </div>
  );
}
