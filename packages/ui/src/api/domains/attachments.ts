import { request, requestBlob, uploadFile } from "../transport.js";
import type { TaskAttachment } from "../../types/index.js";

export const attachmentsApi = {
  list: (taskId: string) =>
    request<{ attachments: TaskAttachment[] }>(`/tasks/${taskId}/attachments`),
  upload: (taskId: string, file: File, onProgress?: (percent: number) => void) =>
    uploadFile<{ attachment: TaskAttachment }>(`/tasks/${taskId}/attachments`, file, onProgress),
  download: (id: string) =>
    requestBlob(`/attachments/${id}/download`).then(({ blob, headers }) => {
      const disposition = headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="(.+?)"/);
      const filename = match?.[1] ?? "download";
      return { blob, filename };
    }),
  delete: (id: string) => request<void>(`/attachments/${id}`, { method: "DELETE" }),
};
