import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduledTasksApi } from "./scheduledTasks.js";
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, occurrenceId: "o", scheduledFor: "2090-01-01T00:00:00Z", occurrenceState: "published", replayed: false }), { status: 200 })); });
afterEach(() => { vi.unstubAllGlobals(); });
it.each(["2090-01-01T00:00:00Z", "", false])("forwards a supplied occurrence coordinate without truthiness fallback (%j)", async (coordinate) => {
  await scheduledTasksApi.run("schedule-1", coordinate as string);
  expect(fetchMock).toHaveBeenCalledWith("/api/scheduled-tasks/schedule-1/run", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedScheduledFor: coordinate }) }));
});
it("keeps an omitted coordinate bodyless for legacy callers", async () => {
  await scheduledTasksApi.run("schedule-1");
  expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
});
