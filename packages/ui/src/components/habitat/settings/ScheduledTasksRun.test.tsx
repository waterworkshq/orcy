import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduledTasksTab } from "./ScheduledTasksTab.js";
import { ApiError } from "../../../api/transport.js";
import { queryKeys } from "../../../lib/queryKeys.js";
const { list, run, success, error, info } = vi.hoisted(() => ({ list: vi.fn(), run: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ api: { scheduledTasks: { list, run }, templates: { list: async () => ({ templates: [] }) } } }));
vi.mock("../../../lib/toast.js", () => ({ notify: { success, error, info } }));
const A = "2090-01-01T13:00:00.000Z";
const B = "2090-01-01T13:05:00.000Z";
const schedule = { id: "schedule-1", habitatId: "h1", name: "Manual work", description: "", templateId: null,
  scheduleType: "interval", intervalMinutes: 5, scheduledAt: A, cronExpression: null, timezone: "UTC", missionTitle: "Work",
  tasksTemplate: [], enabled: true, lastRunAt: null, nextRunAt: A, runCount: 0, lastCreatedMissionId: null, missionLabels: [] };
let row = { ...schedule };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); row = { ...schedule }; list.mockImplementation(async () => ({ scheduledTasks: [row] })); });
afterEach(cleanup);
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (habitatId = "h1") => <QueryClientProvider client={qc}><ScheduledTasksTab habitatId={habitatId} /></QueryClientProvider>;
  return { qc, tree, ...render(tree()) };
}
function published(coordinate = A, replayed = true) { return { success: true, occurrenceId: "occurrence-1", scheduledFor: coordinate, occurrenceState: "published", replayed, missionId: "mission-1" }; }

it.each(["transport", "infrastructure"])("retains uncertain %s request A across actual refetch to B and retries A before a later deliberate Run B", async (failure) => {
  let rejectFirst!: (error: Error) => void;
  run.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  const { qc } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(1, "schedule-1", A));
  await act(async () => { rejectFirst(failure === "transport" ? new TypeError("Response lost") : new ApiError("Committed result not confirmed", 500)); });
  const retry = await screen.findByRole("button", { name: "Retry Run" });
  row = { ...row, nextRunAt: B, runCount: 1 };
  await act(async () => { await qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list("h1") }); });
  await screen.findByText(`Next: ${new Date(row.nextRunAt).toLocaleString()}`);
  expect(list.mock.calls.length).toBeGreaterThan(1);
  run.mockResolvedValueOnce(published());
  fireEvent.click(retry);
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", A));
  const fresh = await screen.findByRole("button", { name: "Run" });
  run.mockResolvedValueOnce(published(B, false));
  fireEvent.click(fresh);
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(3, "schedule-1", B));
});

it("retires old-view run settlement at commit and does not clear the new view's in-flight run", async () => {
  let resolveOld!: (result: unknown) => void;
  let resolveNew!: (result: unknown) => void;
  run.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
  const view = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(1, "schedule-1", A));
  row = { ...row, habitatId: "h2", nextRunAt: B };
  view.rerender(view.tree("h2"));
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", B));
  await act(async () => { resolveOld(published(A, false)); });
  expect(success).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Run" })).toHaveProperty("disabled", true);
  await act(async () => { resolveNew(published(B, false)); });
  expect(success).toHaveBeenCalledTimes(1);
});

it("permits explicit retry A after a once refetch shows disabled consumption", async () => {
  row = { ...row, scheduleType: "once" };
  run.mockRejectedValueOnce(new TypeError("Response lost"));
  const { qc } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await screen.findByRole("button", { name: "Retry Run" });
  row = { ...row, enabled: false, nextRunAt: "9999-12-31T23:59:59.000Z", runCount: 1 };
  await act(async () => { await qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list("h1") }); });
  await screen.findByText(`Next: ${new Date(row.nextRunAt).toLocaleString()}`);
  const retry = screen.getByRole("button", { name: "Retry Run" });
  expect(retry).toHaveProperty("disabled", false);
  run.mockResolvedValueOnce(published());
  fireEvent.click(retry);
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", A));
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toHaveProperty("disabled", true));
});

it.each(["unmount", "account"])("ignores a retired %s view's late settlement", async (retirement) => {
  let resolve!: (result: unknown) => void;
  run.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  if (retirement === "unmount") view.unmount();
  else { localStorage.setItem("orcy_token", "another-account-fixture"); view.rerender(view.tree()); }
  await act(async () => { resolve(published()); });
  expect(success).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

it("keeps pending replay identity and describes handler-only completion without a created Mission", async () => {
  run.mockResolvedValueOnce({ success: true, occurrenceId: "o1", scheduledFor: A, occurrenceState: "reserved", replayed: false, skipped: true });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const retry = await screen.findByRole("button", { name: "Retry Run" });
  expect(info).toHaveBeenCalledWith(expect.stringContaining("pending"));
  expect(success).not.toHaveBeenCalled();
  run.mockResolvedValueOnce({ ...published(), missionId: undefined });
  fireEvent.click(retry);
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", A));
  await waitFor(() => expect(success).toHaveBeenCalledWith("Previous run completed"));
});

it("clears a definitively stale request so a later deliberate Run can select B", async () => {
  run.mockRejectedValueOnce(new ApiError("Slot changed", 409, { code: "SCHEDULE_RUN_STALE" }));
  const { qc } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("Slot changed"));
  expect(screen.queryByRole("button", { name: "Retry Run" })).toBeNull();
  row = { ...row, nextRunAt: B };
  await act(async () => { await qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list("h1") }); });
  await screen.findByText(`Next: ${new Date(row.nextRunAt).toLocaleString()}`);
  run.mockResolvedValueOnce(published(B, false));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", B));
});

it.each([[401, "UNAUTHORIZED"], [403, "BOARD_ACCESS_DENIED"], [409, "CONFLICT"]] as const)("retains uncertain A across refetch B and an unresolved %s retry denial", async (status, code) => {
  run.mockRejectedValueOnce(new TypeError("Response lost"));
  const { qc } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await screen.findByRole("button", { name: "Retry Run" });
  row = { ...row, nextRunAt: B, runCount: 1 };
  await act(async () => { await qc.invalidateQueries({ queryKey: queryKeys.scheduledTasks.list("h1") }); });
  await screen.findByText(`Next: ${new Date(B).toLocaleString()}`);
  run.mockRejectedValueOnce(new ApiError("Run lookup unavailable", status, { code }));
  fireEvent.click(screen.getByRole("button", { name: "Retry Run" }));
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", A));
  // Revocation precedes pair lookup and cannot resolve the original request.
  const retry = await screen.findByRole("button", { name: "Retry Run" });
  run.mockResolvedValueOnce(published());
  fireEvent.click(retry);
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(3, "schedule-1", A));
  await screen.findByRole("button", { name: "Run" });
});

it("does not resolve A from an unmatched rejected occurrence response", async () => {
  run.mockResolvedValueOnce({ success: false, occurrenceId: "unmatched", scheduledFor: B, occurrenceState: "rejected", replayed: true, error: "Unmatched rejection" });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const retry = await screen.findByRole("button", { name: "Retry Run" });
  run.mockResolvedValueOnce(published());
  fireEvent.click(retry);
  await waitFor(() => expect(run).toHaveBeenNthCalledWith(2, "schedule-1", A));
});
