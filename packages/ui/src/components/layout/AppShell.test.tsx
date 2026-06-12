import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@testing-library/jest-dom/vitest";
import { AppShell } from "./AppShell.js";
import { useRegisterDrawerBridge } from "./DrawerBridgeContext.js";

const mockAgents = [{ id: "a1", name: "Alpha-1", status: "working" }];

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (selector?: any) => {
    const state = { agents: mockAgents, notifications: [] };
    return selector ? selector(state) : state;
  },
}));

vi.mock("../habitat/TaskDetailModal.js", () => ({
  TaskDetailModal: () => <div data-testid="task-detail-modal" />,
}));

function BoardRouteHarness({ onOpenStats }: { onOpenStats: () => void }) {
  const registerDrawerBridge = useRegisterDrawerBridge();

  React.useEffect(() => registerDrawerBridge({ onOpenStats }), [onOpenStats, registerDrawerBridge]);

  return <div data-testid="board-route">Board route</div>;
}

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders SideNavBar, TopAppBar, and child route outlet", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<div data-testid="outlet-child">Outlet child</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
    expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
    expect(screen.getByTestId("outlet-child")).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-modal")).toBeInTheDocument();
  });

  it("passes registered drawer callbacks to SideNavBar", () => {
    const onOpenStats = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/boards/board-1"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/boards/:habitatId"
                element={<BoardRouteHarness onOpenStats={onOpenStats} />}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("tool-item-stats"));
    expect(onOpenStats).toHaveBeenCalledOnce();
  });
});
