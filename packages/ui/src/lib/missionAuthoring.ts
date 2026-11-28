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
const twoDigits = (value: number): string => String(value).padStart(2, "0");
/**
 * Local wall-clock text of a stored instant, the way a `datetime-local` field shows it.
 * A zone-free datetime-local value is read back as local time, so the field must be
 * filled with the same wall clock the user will read it as.
 */
function localDateTimeValue(instant: string | null | undefined): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}
export function missionToDraft(mission: MissionWithProgress): MissionDraft {
  return { title: mission.title, description: mission.description, priority: mission.priority,
    labels: mission.labels.join(", "), dueAt: localDateTimeValue(mission.dueAt),
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
/**
 * The deadline an update carries. A deadline the user never touched is left out of the
 * PATCH so the server keeps the stored instant exactly (its own precision included);
 * a chosen one is the local wall clock the user picked, and a cleared one is an
 * explicit null.
 */
function resolveDueAt(value: string, baselineDueAt?: string): string | null | undefined {
  if (baselineDueAt !== undefined && value === baselineDueAt) return undefined;
  if (!value) return null;
  return new Date(value).toISOString();
}
export function updateMissionInputFromDraft(draft: MissionDraft, version: number, releaseMode: boolean, baselineDueAt?: string): Partial<Mission> & { version: number } {
  const dueAt = resolveDueAt(draft.dueAt, baselineDueAt);
  return { title: draft.title.trim(), description: draft.description.trim(), priority: draft.priority,
    labels: labelsFrom(draft.labels), ...(dueAt === undefined ? {} : { dueAt }),
    slaMinutes: draft.slaMinutes ? parseInt(draft.slaMinutes, 10) : null, version,
    ...(releaseMode ? { releaseGateType: draft.releaseGateType || null,
      releaseGateVersion: draft.releaseGateType ? draft.releaseGateVersion.trim() || null : null,
      releaseDeadlineType: draft.releaseDeadlineType || null,
      releaseDeadlineVersion: draft.releaseDeadlineType ? draft.releaseDeadlineVersion.trim() || null : null } : {}) };
}
function sessionFrom(mission?: MissionWithProgress) {
  const draft = mission ? missionToDraft(mission) : emptyMissionDraft();
  return { draft, baselineVersion: mission?.version, baselineMissionId: mission?.id,
    /** The deadline text the draft was seeded with, so an untouched one stays untouched. */
    baselineDueAt: draft.dueAt };
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
    baselineDueAt: session.baselineDueAt,
    setTitle: (title: string) => patch({ title }), setDescription: (description: string) => patch({ description }),
    setPriority: (priority: TaskPriority) => patch({ priority }), setLabels: (labels: string) => patch({ labels }),
    setDueAt: (dueAt: string) => patch({ dueAt }), setSlaMinutes: (slaMinutes: string) => patch({ slaMinutes }),
    setReleaseGateType: (releaseGateType: ReleaseLevel) => patch({ releaseGateType }),
    setReleaseGateVersion: (releaseGateVersion: string) => patch({ releaseGateVersion }),
    setReleaseDeadlineType: (releaseDeadlineType: ReleaseLevel) => patch({ releaseDeadlineType }),
    setReleaseDeadlineVersion: (releaseDeadlineVersion: string) => patch({ releaseDeadlineVersion }) };
}
