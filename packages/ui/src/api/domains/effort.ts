import { request } from "../transport.js";
import type {
  EffortReport,
  EffortEntryWithActor,
  EffortEntry,
  MissionEffortReport,
} from "../../types/index.js";

export const effortApi = {
  getReport: (taskId: string) => request<EffortReport>(`/tasks/${taskId}/effort-report`),
  listEntries: (taskId: string, includeCorrections = true) =>
    request<EffortEntryWithActor[]>(
      `/tasks/${taskId}/effort-entries?includeCorrections=${includeCorrections}`,
    ),
  log: (taskId: string, minutes: number, note?: string, startedAt?: string, endedAt?: string) =>
    request<EffortEntry>(`/tasks/${taskId}/effort-entries`, {
      method: "POST",
      body: JSON.stringify({ minutes, note, startedAt, endedAt }),
    }),
  correct: (
    taskId: string,
    entryId: string,
    minutesDelta: number,
    correctionReason: string,
    note?: string,
  ) =>
    request<EffortEntry>(`/tasks/${taskId}/effort-entries/${entryId}/correct`, {
      method: "POST",
      body: JSON.stringify({ minutesDelta, correctionReason, note }),
    }),
  getMissionReport: (missionId: string) =>
    request<MissionEffortReport>(`/missions/${missionId}/effort-report`),
};
