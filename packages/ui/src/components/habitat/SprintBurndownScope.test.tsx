import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SprintPlanningPanel } from "./SprintPlanningPanel.js";

vi.mock("../ui/Drawer.js", () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../dashboard/BurndownChart.js", () => ({
  BurndownChart: ({ data }: { data: unknown[] }) => (
    <pre data-testid="chart">{JSON.stringify(data)}</pre>
  ),
}));

// These response shapes and the two task populations are paired with the API
// control in sprintBurndownScope.inject.test.ts. Fetch is the only transport seam.
const point = (remaining: number) => ({
  date: "2026-06-02",
  completed: 1 - remaining,
  remaining,
  idealRemaining: 0.9,
  totalTasks: 1,
});
const sprint = (status: "planning" | "active") => ({
  id: "sprint-1",
  habitatId: "hab-1",
  name: "Sprint Alpha",
  goal: "Ship",
  startDate: "2026-06-01",
  endDate: "2026-06-14",
  status,
  committedMissionIds: ["committed"],
  completedMissionIds: [],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(["planning", "active"] as const)(
  "%s Sprint expansion",
  (status) => {
    it("shows one Sprint-scoped series while preserving dashboard metrics", async () => {
      let committedDone = false;
      let unrelatedDone = false;
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          requests.push(url);
          let data: unknown;
          if (url === "/api/habitats/hab-1")
            data = {
              missions: [
                { id: "committed", title: "Committed" },
                { id: "outside", title: "Outside" },
              ],
            };
          else if (url === "/api/habitats/hab-1/sprints")
            data = { sprints: [sprint(status)] };
          else if (url === "/api/habitats/hab-1/sprints/active")
            data = { sprint: status === "active" ? sprint(status) : null };
          else if (url === "/api/habitats/hab-1/tasks")
            data = {
              tasks: [
                {
                  missionId: "committed",
                  status: committedDone ? "done" : "pending",
                },
                {
                  missionId: "outside",
                  status: unrelatedDone ? "done" : "pending",
                },
              ],
            };
          else if (url.startsWith("/api/habitats/hab-1/burndown"))
            data = {
              data: [
                {
                  ...point(1),
                  remaining: (committedDone ? 0 : 1) + (unrelatedDone ? 0 : 1),
                },
              ],
            };
          else if (url === "/api/sprints/sprint-1/burndown")
            data = { data: [point(committedDone ? 0 : 1)] };
          else if (url === "/api/sprints/sprint-1/metrics")
            data = {
              completionPercentage: 0,
              completedTasks: 0,
              totalTasks: 1,
              velocity: 0,
              remainingDays: 1,
              carryOverCount: 0,
              plannedMinutes: null,
              loggedEffortMinutes: 0,
              isOnTrack: true,
              warnings: [],
            };
          else if (url === "/api/sprints/sprint-1/carry-over")
            data = { carriedOverMissions: [], warnings: [] };
          else throw new Error(`Unexpected request: ${url}`);
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <SprintPlanningPanel habitatId="hab-1" onClose={() => {}} />
        </QueryClientProvider>,
      );
      fireEvent.click(await screen.findByText("Sprint Alpha"));
      await waitFor(() =>
        expect(screen.getAllByTestId("chart")).toHaveLength(1),
      );
      expect(screen.getByTestId("chart").textContent).toBe(
        JSON.stringify([point(1)]),
      );
      const taskCard = screen.getByText("Tasks").closest(".rounded-lg");
      expect(taskCard).not.toBeNull();
      await waitFor(() => expect(within(taskCard as HTMLElement).getByText("0/1")).toBeTruthy());
      expect(
        screen.getByText(status === "planning" ? "Start" : "Complete"),
      ).toBeTruthy();
      expect(requests).toContain("/api/sprints/sprint-1/burndown");
      expect(
        requests.some((url) => url.startsWith("/api/habitats/hab-1/burndown")),
      ).toBe(false);

      unrelatedDone = true;
      await client.invalidateQueries();
      await waitFor(() =>
        expect(screen.getByTestId("chart").textContent).toBe(
          JSON.stringify([point(1)]),
        ),
      );
      committedDone = true;
      await client.invalidateQueries();
      await waitFor(() =>
        expect(screen.getByTestId("chart").textContent).toBe(
          JSON.stringify([point(0)]),
        ),
      );
      await waitFor(() => expect(within(taskCard as HTMLElement).getByText("1/1")).toBeTruthy());
      expect(screen.getAllByTestId("chart")).toHaveLength(1);
    });
  },
);
