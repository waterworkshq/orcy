import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSetTheme = vi.hoisted(() => vi.fn());

function ParamsEcho() {
  const { id } = useParams();
  return <div data-testid="mission-detail-page">MissionDetailPage:{id}</div>;
}

vi.mock("./api/index.js", () => ({
  api: {
    features: {
      details: (..._args: any[]) => Promise.resolve({}),
    },
  },
}));

vi.mock("./components/habitat/HabitatListPage.js", () => ({
  HabitatListPage: () => <div data-testid="habitat-list-page">HabitatListPage</div>,
}));

vi.mock("./components/habitat/HabitatPage.js", () => ({
  HabitatPage: () => <div data-testid="habitat-page">HabitatPage</div>,
}));

vi.mock("./components/habitat/TeamsPage.js", () => ({
  TeamsPage: () => <div data-testid="teams-page">TeamsPage</div>,
}));

vi.mock("./components/auth/AuthPage.js", () => ({
  AuthPage: () => <div data-testid="auth-page">AuthPage</div>,
}));

vi.mock("./pages/DashboardPage.js", () => ({
  DashboardPage: () => <div data-testid="dashboard-page">DashboardPage</div>,
}));

vi.mock("./pages/MissionDetailPage.js", () => ({
  MissionDetailPage: ParamsEcho,
}));

vi.mock("./pages/AgentsPage.js", () => ({
  AgentsPage: () => <div data-testid="agents-page">AgentsPage</div>,
}));

vi.mock("./pages/ActivityPage.js", () => ({
  ActivityPage: () => <div data-testid="activity-page">ActivityPage</div>,
}));

vi.mock("./pages/SettingsPage.js", () => ({
  SettingsPage: () => <div data-testid="settings-page">SettingsPage</div>,
}));

vi.mock("./components/ui/Toast.js", () => ({
  GlassToaster: () => null,
}));

vi.mock("./components/ui/ErrorBoundary.js", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./components/habitat/TaskDetailModal.js", () => ({
  TaskDetailModal: () => <div data-testid="task-detail-modal" />,
}));

vi.mock("./store/habitatStore.js", () => ({
  useHabitatStore: (selector?: any) => {
    const state = {
      setTheme: mockSetTheme,
      agents: [],
      notifications: [],
      markNotificationRead: vi.fn(),
      clearNotifications: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import App from "./App.js";

function renderApp(initialPath: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("orcy_token", "test-token");
    document.documentElement.className = "";
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.className = "";
  });

  it("always applies dark mode to the html element", async () => {
    localStorage.setItem("orcy-theme", "light");

    renderApp("/");

    await waitFor(() => {
      expect(document.documentElement).toHaveClass("dark");
      expect(mockSetTheme).toHaveBeenCalledWith("dark");
    });
  });

  it("renders HabitatListPage at /", () => {
    renderApp("/");
    expect(screen.getByTestId("habitat-list-page")).toBeInTheDocument();
    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
    expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
  });

  it("renders HabitatPage at /habitats/:habitatId", () => {
    renderApp("/habitats/habitat-123");
    expect(screen.getByTestId("habitat-page")).toBeInTheDocument();
    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
    expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
  });

  it("renders TeamsPage at /teams", () => {
    renderApp("/teams");
    expect(screen.getByTestId("teams-page")).toBeInTheDocument();
    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
  });

  it("renders DashboardPage at /dashboard", async () => {
    renderApp("/dashboard");
    await waitFor(() => {
      expect(screen.getByTestId("dashboard-page")).toBeInTheDocument();
    });
    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
  });

  it("renders AuthPage at /login", () => {
    localStorage.removeItem("orcy_token");
    renderApp("/login");
    expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    expect(screen.queryByTestId("side-nav-bar")).toBeNull();
    expect(screen.queryByTestId("top-app-bar")).toBeNull();
  });

  it("redirects to /login when unauthenticated", () => {
    localStorage.removeItem("orcy_token");
    renderApp("/");
    expect(screen.getByTestId("auth-page")).toBeInTheDocument();
  });

  describe("/missions/:id route", () => {
    it("registers the route and renders MissionDetailPage", () => {
      renderApp("/missions/mission-42");
      expect(screen.getByTestId("mission-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
      expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
    });

    it("passes route params to MissionDetailPage", () => {
      renderApp("/missions/mission-42");
      expect(screen.getByTestId("mission-detail-page")).toHaveTextContent(
        "MissionDetailPage:mission-42",
      );
    });

    it("requires authentication", () => {
      localStorage.removeItem("orcy_token");
      renderApp("/missions/mission-1");
      expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    });

    it("works with different IDs", () => {
      renderApp("/missions/abc-123-xyz");
      expect(screen.getByTestId("mission-detail-page")).toHaveTextContent(
        "MissionDetailPage:abc-123-xyz",
      );
    });
  });

  describe("/agents route", () => {
    it("renders AgentsPage", () => {
      renderApp("/agents");
      expect(screen.getByTestId("agents-page")).toBeInTheDocument();
      expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
      expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
    });

    it("requires authentication", () => {
      localStorage.removeItem("orcy_token");
      renderApp("/agents");
      expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    });
  });

  describe("/habitats/:habitatId/activity route", () => {
    it("renders ActivityPage", () => {
      renderApp("/habitats/b1/activity");
      expect(screen.getByTestId("activity-page")).toBeInTheDocument();
      expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
      expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
    });

    it("requires authentication", () => {
      localStorage.removeItem("orcy_token");
      renderApp("/habitats/b1/activity");
      expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    });
  });

  describe("/settings route", () => {
    it("renders SettingsPage when authenticated", () => {
      renderApp("/settings");
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
      expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
      expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
    });

    it("requires authentication", () => {
      localStorage.removeItem("orcy_token");
      renderApp("/settings");
      expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    });
  });

  it("preserves all existing routes after adding feature route", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const routes = [
      { path: "/", testId: "habitat-list-page" },
      { path: "/habitats/b1", testId: "habitat-page" },
      { path: "/dashboard", testId: "dashboard-page" },
      { path: "/teams", testId: "teams-page" },
      { path: "/agents", testId: "agents-page" },
      { path: "/habitats/b1/activity", testId: "activity-page" },
      { path: "/missions/f1", testId: "mission-detail-page" },
      { path: "/settings", testId: "settings-page" },
    ];

    for (const { path, testId } of routes) {
      const { unmount } = render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(
        screen.getByTestId(testId),
        `Route ${path} should render ${testId}`,
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("preserves AppShell while navigating between authenticated pages", () => {
    renderApp("/habitats/b1");

    expect(screen.getByTestId("habitat-page")).toBeInTheDocument();
    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("top-nav-pod-base"));

    expect(screen.getByTestId("dashboard-page")).toBeInTheDocument();
    expect(screen.getByTestId("side-nav-bar")).toBeInTheDocument();
    expect(screen.getByTestId("top-app-bar")).toBeInTheDocument();
  });
});
