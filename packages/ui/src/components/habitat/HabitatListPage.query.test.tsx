import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { onlineManager, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { SessionStateProvider } from "../../lib/sessionState.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { HabitatListPage } from "./HabitatListPage.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mount() {
  return render(<MemoryRouter><SessionStateProvider><HabitatListPage /></SessionStateProvider></MemoryRouter>);
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.unstubAllGlobals(); });

it("does not welcome an existing user while the habitat list is pending or after it resolves", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => { resolve = done; });
  vi.stubGlobal("fetch", vi.fn((path: string) => path === "/api/habitats" ? pending : Promise.resolve(json({ teams: [] }))));
  mount();
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  await act(async () => resolve(json({ habitats: [{ id: "h", name: "Existing", createdAt: "2024-01-01" }] })));
  expect(await screen.findByText("Existing")).toBeTruthy();
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
});

it("offers retry after the initial read fails, then shows the recovered list", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path !== "/api/habitats") return Promise.resolve(json({ teams: [] }));
    attempts++;
    return Promise.resolve(attempts <= 2 ? json({ error: "Unavailable" }, 500) : json({ habitats: [{ id: "h", name: "Recovered", createdAt: "2024-01-01" }] }));
  }));
  mount();
  const retry = await screen.findByRole("button", { name: "Retry" }, { timeout: 4000 });
  expect(attempts).toBe(2);
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  expect(screen.queryByText(/No habitats yet/)).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText("Recovered")).toBeTruthy();
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
});

it.each([false, true])("shows onboarding for an empty list only when incomplete (completed=%s)", async (completed) => {
  if (completed) localStorage.setItem("orcy_onboarding_completed", "true");
  vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(json(path === "/api/habitats" ? { habitats: [] } : { teams: [] }))));
  mount();
  expect(await screen.findByText(/No habitats yet/)).toBeTruthy();
  if (completed) expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  else expect(await screen.findByText("Welcome to Orcy")).toBeTruthy();
});

it("retains ordered cached habitats during and after a failed refetch", async () => {
  localStorage.setItem("orcy_onboarding_completed", "true");
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path !== "/api/habitats") return Promise.resolve(json({ teams: [] }));
    attempts++;
    return Promise.resolve(attempts === 1 ? json({ habitats: [
      { id: "a", name: "Alpha", createdAt: "2024-01-01" },
      { id: "b", name: "Beta", createdAt: "2024-01-02" },
    ] }) : json({ error: "Unavailable" }, 500));
  }));
  let client!: QueryClient;
  function Refresh() {
    client = useQueryClient();
    return <button onClick={() => void client.invalidateQueries({ queryKey: queryKeys.habitats.list() })}>Refresh</button>;
  }
  render(<MemoryRouter><SessionStateProvider><Refresh /><HabitatListPage /></SessionStateProvider></MemoryRouter>);
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByText("Alpha")).toBeTruthy();
  await vi.waitFor(() => expect(client.getQueryState(queryKeys.habitats.list())?.status).toBe("error"), { timeout: 4000 });
  const links = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/habitats/"));
  expect(links.map((link) => link.textContent)).toEqual([expect.stringContaining("Alpha"), expect.stringContaining("Beta")]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not show an empty list when the initial query is paused offline", async () => {
  onlineManager.setOnline(false);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ habitats: [] }))));
  mount();
  expect(screen.queryByText(/No habitats yet/)).toBeNull();
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  act(() => onlineManager.setOnline(true));
  expect(await screen.findByText("Welcome to Orcy")).toBeTruthy();
});

it("waits for a stale empty cache to refetch before welcoming", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => { resolve = done; });
  vi.stubGlobal("fetch", vi.fn((path: string) => path === "/api/habitats" ? pending : Promise.resolve(json({ teams: [] }))));
  function Seed() {
    const client = useQueryClient();
    client.setQueryData(queryKeys.habitats.list(), [], { updatedAt: 1 });
    return <HabitatListPage />;
  }
  render(<MemoryRouter><SessionStateProvider><Seed /></SessionStateProvider></MemoryRouter>);
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  await act(async () => resolve(json({ habitats: [{ id: "h", name: "Existing", createdAt: "2024-01-01" }] })));
  expect(await screen.findByText("Existing")).toBeTruthy();
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
});

it("shows retry if a refresh of an empty cache fails", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path !== "/api/habitats") return Promise.resolve(json({ teams: [] }));
    attempts++;
    return Promise.resolve(attempts === 1 ? json({ habitats: [] }) : json({ error: "Unavailable" }, 500));
  }));
  function Refresh() {
    const client = useQueryClient();
    return <button onClick={() => void client.invalidateQueries({ queryKey: queryKeys.habitats.list() })}>Refresh</button>;
  }
  render(<MemoryRouter><SessionStateProvider><Refresh /><HabitatListPage /></SessionStateProvider></MemoryRouter>);
  await screen.findByText("Welcome to Orcy");
  fireEvent.click(screen.getByRole("button", { name: "Refresh", hidden: true }));
  expect(await screen.findByRole("button", { name: "Retry" }, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  expect(screen.queryByText(/No habitats yet/)).toBeNull();
});

it("closes onboarding if a refresh discovers a habitat", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path !== "/api/habitats") return Promise.resolve(json({ teams: [] }));
    return Promise.resolve(++attempts === 1 ? json({ habitats: [] }) : json({ habitats: [{ id: "h", name: "New habitat", createdAt: "2024-01-01" }] }));
  }));
  function Refresh() {
    const client = useQueryClient();
    return <button onClick={() => void client.invalidateQueries({ queryKey: queryKeys.habitats.list() })}>Refresh</button>;
  }
  render(<MemoryRouter><SessionStateProvider><Refresh /><HabitatListPage /></SessionStateProvider></MemoryRouter>);
  await screen.findByText("Welcome to Orcy");
  fireEvent.click(screen.getByRole("button", { name: "Refresh", hidden: true }));
  expect(await screen.findByText("New habitat")).toBeTruthy();
  await vi.waitFor(() => expect(screen.queryByText("Welcome to Orcy")).toBeNull());
});
