import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetConfig } from "@orcy/shared";
import { KanbanApiClient } from "../api.js";
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubEnv("ORCY_API_KEY", "manual-client-fixture"); vi.stubEnv("ORCY_AGENT_ID", "fixture-agent"); vi.stubEnv("ORCY_REMOTE_KEY", ""); resetConfig(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, occurrenceId: "o", scheduledFor: "2090-01-01T00:00:00Z", occurrenceState: "published", replayed: false }), { status: 200 })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetConfig(); });
it.each(["2090-01-01T00:00:00Z", "", false])("forwards an explicitly supplied manual coordinate (%j)", async (coordinate) => {
  const client = new KanbanApiClient("http://manual-run.test");
  await client.runScheduledTask("schedule-1", coordinate as string);
  expect(fetchMock.mock.calls[0][0]).toBe("http://manual-run.test/api/scheduled-tasks/schedule-1/run");
  expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ expectedScheduledFor: coordinate }));
});
it("keeps omitted coordinates bodyless", async () => {
  await new KanbanApiClient("http://manual-run.test").runScheduledTask("schedule-1");
  expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
});
