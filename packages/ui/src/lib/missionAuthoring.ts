import { useEffect, useRef, useState } from "react";
import type { CreateMissionInput, Mission, MissionWithProgress, TaskPriority } from "../types/index.js";
export type ReleaseLevel = "patch" | "minor" | "major" | "";
export interface MissionDraft {
  title: string; description: string; priority: TaskPriority; labels: string;
  dueAt: string; slaMinutes: string; releaseGateType: ReleaseLevel; releaseGateVersion: string;
  releaseDeadlineType: ReleaseLevel; releaseDeadlineVersion: string;
}
export function emptyMissionDraft(): MissionDraft {
  return { title: "", description: "", priority: "medium", labels: "", dueAt: "", slaMinutes: "",
    releaseGateType: "", releaseGateVersion: "", releaseDeadlineType: "", releaseDeadlineVersion: "" };
}
export function missionToDraft(mission: MissionWithProgress): MissionDraft {
  return { title: mission.title, description: mission.description, priority: mission.priority,
    labels: mission.labels.join(", "), dueAt: mission.dueAt ? mission.dueAt.slice(0, 16) : "",
    slaMinutes: mission.slaMinutes ? String(mission.slaMinutes) : "",
    releaseGateType: mission.releaseGateType ?? "", releaseGateVersion: mission.releaseGateVersion ?? "",
    releaseDeadlineType: mission.releaseDeadlineType ?? "", releaseDeadlineVersion: mission.releaseDeadlineVersion ?? "" };
}
export function releaseAuthoringEnabled(data: { habitat?: { roadmapSettings?: { mode?: string } | null } } | undefined): boolean {
  return data?.habitat?.roadmapSettings?.mode !== "feature";
}
export const titleReady = (draft: MissionDraft): boolean => draft.title.trim().length > 0;
const labelsFrom = (text: string) => text.split(",").map((label) => label.trim()).filter(Boolean);
export function createMissionInputFromDraft(draft: MissionDraft, columnId: string, acceptanceCriteria: string, releaseMode = false): CreateMissionInput {
  const labels = labelsFrom(draft.labels);
  return { columnId, title: draft.title.trim(), description: draft.description.trim() || undefined,
    acceptanceCriteria: acceptanceCriteria.trim() || undefined, priority: draft.priority,
    labels: labels.length ? labels : undefined, dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : undefined,
    slaMinutes: draft.slaMinutes ? parseInt(draft.slaMinutes, 10) : undefined,
    ...(releaseMode ? { releaseGateType: draft.releaseGateType || undefined,
      releaseGateVersion: draft.releaseGateType ? draft.releaseGateVersion.trim() || undefined : undefined,
      releaseDeadlineType: draft.releaseDeadlineType || undefined,
      releaseDeadlineVersion: draft.releaseDeadlineType ? draft.releaseDeadlineVersion.trim() || undefined : undefined } : {}) };
}
export function updateMissionInputFromDraft(draft: MissionDraft, version: number, releaseMode: boolean): Partial<Mission> & { version: number } {
  return { title: draft.title.trim(), description: draft.description.trim(), priority: draft.priority,
    labels: labelsFrom(draft.labels), dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null,
    slaMinutes: draft.slaMinutes ? parseInt(draft.slaMinutes, 10) : null, version,
    ...(releaseMode ? { releaseGateType: draft.releaseGateType || null,
      releaseGateVersion: draft.releaseGateType ? draft.releaseGateVersion.trim() || null : null,
      releaseDeadlineType: draft.releaseDeadlineType || null,
      releaseDeadlineVersion: draft.releaseDeadlineType ? draft.releaseDeadlineVersion.trim() || null : null } : {}) };
}
function sessionFrom(mission?: MissionWithProgress) {
  return { draft: mission ? missionToDraft(mission) : emptyMissionDraft(),
    baselineVersion: mission?.version, baselineMissionId: mission?.id };
}
/** Same open record refetch never rebases its draft or expected version. */
export function useMissionAuthoring(open: boolean, mission?: MissionWithProgress) {
  const [session, setSession] = useState(() => sessionFrom(mission));
  const key = open ? `open:${mission?.id ?? "create"}` : "closed";
  const priorKey = useRef(key);
  useEffect(() => {
    if (priorKey.current === key) return;
    priorKey.current = key;
    if (open) setSession(sessionFrom(mission));
  }, [key, open, mission]);
  const patch = (value: Partial<MissionDraft>) => setSession((old) => ({ ...old, draft: { ...old.draft, ...value } }));
  return { ...session.draft, draft: session.draft,
    baselineVersion: session.baselineVersion, baselineMissionId: session.baselineMissionId,
    setTitle: (title: string) => patch({ title }), setDescription: (description: string) => patch({ description }),
    setPriority: (priority: TaskPriority) => patch({ priority }), setLabels: (labels: string) => patch({ labels }),
    setDueAt: (dueAt: string) => patch({ dueAt }), setSlaMinutes: (slaMinutes: string) => patch({ slaMinutes }),
    setReleaseGateType: (releaseGateType: ReleaseLevel) => patch({ releaseGateType }),
    setReleaseGateVersion: (releaseGateVersion: string) => patch({ releaseGateVersion }),
    setReleaseDeadlineType: (releaseDeadlineType: ReleaseLevel) => patch({ releaseDeadlineType }),
    setReleaseDeadlineVersion: (releaseDeadlineVersion: string) => patch({ releaseDeadlineVersion }) };
}
