import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduledTasksTab } from "./ScheduledTasksTab.js";
const { list, create, update, remove, enable, disable, success, error, info } = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), enable: vi.fn(), disable: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(),
}));
vi.mock("../../../api/index.js", () => ({ api: {
  scheduledTasks: { list, create, update, delete: remove, enable, disable },
  templates: { list: async () => ({ templates: [] }) },
} }));
vi.mock("../../../lib/toast.js", () => ({ notify: { success, error, info } }));
const task = { id: "mutation-1", habitatId: "h1", name: "Mutation work", description: "", templateId: null,
  scheduleType: "interval", intervalMinutes: 5, scheduledAt: null, cronExpression: null, timezone: "UTC", missionTitle: "Work",
  missionDescription: "", missionPriority: "medium", missionLabels: [], missionDomain: null, tasksTemplate: [], enabled: true,
  lastRunAt: null, nextRunAt: "2090-01-01T13:00:00.000Z", runCount: 0, lastCreatedMissionId: null };
let enabled = true;
beforeEach(() => {
  for (const mock of [list, create, update, remove, enable, disable, success, error, info]) mock.mockReset();
  localStorage.clear(); enabled = true;
  list.mockImplementation(async (habitatId) => ({ scheduledTasks: [{ ...task, habitatId, enabled }] }));
});
afterEach(cleanup);
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidation = vi.spyOn(qc, "invalidateQueries");
  const tree = (habitatId = "h1") => <QueryClientProvider client={qc}><ScheduledTasksTab habitatId={habitatId} /></QueryClientProvider>;
  return { qc, invalidation, tree, ...render(tree()) };
}
async function start(action: string) {
  if (action === "create") {
    fireEvent.click(await screen.findByRole("button", { name: "Add Scheduled Task" }));
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Fresh schedule" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), { target: { value: "0 9 * * *" } });
    fireEvent.change(screen.getByTestId("st-mission-title"), { target: { value: "Fresh mission" } });
    fireEvent.click(screen.getByTestId("st-submit"));
  } else if (action === "update") {
    fireEvent.click(await screen.findByTestId("edit-btn-mutation-1"));
    fireEvent.click(await screen.findByTestId("st-submit"));
  } else if (action === "delete") {
    fireEvent.click(await screen.findByTestId("delete-btn-mutation-1"));
  } else {
    fireEvent.click(await screen.findByRole("switch"));
  }
}
const actions = { create, update, delete: remove, enable, disable };
const cases = Object.keys(actions).flatMap((action) => ["success", "error"].flatMap((outcome) =>
  ["habitat", "credential"].map((retirement) => ({ action, outcome, retirement }))));
it.each(cases)("retires $action $outcome settlement after committed $retirement change", async ({ action, outcome, retirement }) => {
  if (action === "enable") enabled = false;
  const pending = deferred();
  const api = actions[action as keyof typeof actions];
  api.mockReturnValueOnce(pending.promise);
  const view = setup();
  await start(action);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  if (retirement === "credential") localStorage.setItem("orcy_token", "other-mutation-account-fixture");
  view.rerender(view.tree(retirement === "habitat" ? "h2" : "h1"));
  await screen.findByTestId("edit-btn-mutation-1");
  await act(async () => { if (outcome === "success") pending.resolve({ scheduledTask: task }); else pending.reject(new Error("retired mutation failed")); });
  expect(success).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(view.invalidation).not.toHaveBeenCalled();
  expect(screen.getByTestId("edit-btn-mutation-1")).toHaveProperty("disabled", false);
});
it.each(["success", "error"])("old save %s/finally cannot close or release the new view's pending form", async (outcome) => {
  const oldSave = deferred(); const newSave = deferred();
  update.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
  const view = setup();
  await start("update");
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  view.rerender(view.tree("h2"));
  await start("update");
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  await act(async () => { if (outcome === "success") oldSave.resolve({ scheduledTask: task }); else oldSave.reject(new Error("retired save failed")); });
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  expect(view.invalidation).not.toHaveBeenCalled();
  expect(screen.getByTestId("st-submit")).toHaveProperty("disabled", true);
  await act(async () => { newSave.resolve({ scheduledTask: { ...task, habitatId: "h2" } }); });
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
});
