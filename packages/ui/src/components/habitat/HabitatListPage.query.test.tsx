import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
  function Refresh() {
    const client = useQueryClient();
    return <button onClick={() => void client.invalidateQueries({ queryKey: queryKeys.habitats.list() })}>Refresh</button>;
  }
  render(<MemoryRouter><SessionStateProvider><Refresh /><HabitatListPage /></SessionStateProvider></MemoryRouter>);
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByText("Alpha")).toBeTruthy();
  await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 4000 });
  const links = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/habitats/"));
  expect(links.map((link) => link.textContent)).toEqual([expect.stringContaining("Alpha"), expect.stringContaining("Beta")]);
  expect(screen.queryByRole("alert")).toBeNull();
});
