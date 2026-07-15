import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import "@testing-library/jest-dom/vitest";
import { HabitatListPage } from "./HabitatListPage.js";

const mockHabitats = [
  { id: "hab-1", name: "Alpha Habitat", description: "First habitat", createdAt: "2024-01-01" },
  { id: "hab-2", name: "Beta Habitat", description: null, createdAt: "2024-02-01" },
];

vi.mock("../../lib/useHabitatData.js", () => ({
  useHabitats: () => ({ data: mockHabitats, isLoading: false }),
  useMyTeams: () => ({ data: [], isLoading: false }),
}));

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: {
      create: vi.fn().mockResolvedValue({ id: "new-hab" }),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    habitats: { list: () => ["habitats"], detail: (id: string) => ["habitats", id] },
    teams: { myTeams: () => ["teams"] },
  },
}));

function renderWithRouter(initialEntries = ["/"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/" element={<HabitatListPage />} />
          <Route
            path="/habitats/:habitatId"
            element={<div data-testid="habitat-page">Habitat Page</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HabitatListPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("orcy_onboarding_completed", "true");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders habitat cards with links to /habitats/:id", () => {
    renderWithRouter();
    const links = screen.getAllByRole("link");
    const habitatLinks = links.filter(
      (l) =>
        l.getAttribute("href")?.startsWith("/habitats/") && l.getAttribute("href") !== "/habitats/",
    );
    expect(habitatLinks).toHaveLength(2);
    expect(habitatLinks[0].getAttribute("href")).toBe("/habitats/hab-1");
    expect(habitatLinks[1].getAttribute("href")).toBe("/habitats/hab-2");
  });

  it("navigates to /habitats/:id when clicking a habitat card", () => {
    renderWithRouter();
    const habitatLink = screen.getByText("Alpha Habitat").closest("a");
    expect(habitatLink).toBeTruthy();
    expect(habitatLink!.getAttribute("href")).toBe("/habitats/hab-1");
  });

  it("does not link to legacy /boards/ routes", () => {
    renderWithRouter();
    const links = screen.getAllByRole("link");
    const boardLinks = links.filter((l) => l.getAttribute("href")?.includes("/boards/"));
    expect(boardLinks).toHaveLength(0);
  });
});
