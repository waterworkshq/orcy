import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { WikiPage } from "../pages/WikiPage.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const initial = { id: "created", habitatId: "h", title: "A", content: "Body A", parentId: null, tags: [], status: "draft", links: [], slug: "a", currentVersionNumber: 1, createdBy: "author", lastUpdatedBy: "author", lastUpdatedAt: "2026-10-17T00:00:00Z", createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("preserves edits accepted during creation and saves them against the created page", async () => {
  let finish!: (response: Response) => void;
  let page = { ...initial };
  const writes: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string, options: RequestInit = {}) => {
    const url = String(input); const method = options.method ?? "GET";
    if (method !== "GET") writes.push({ url, method, body: JSON.parse(String(options.body ?? "{}")) });
    if (url.endsWith("/wiki/pages") && method === "POST") return new Promise<Response>((resolve) => { finish = resolve; });
    if (url.endsWith("/wiki/pages/created/versions") && method === "POST") {
      page = { ...page, ...(JSON.parse(String(options.body)) as object), currentVersionNumber: 2 };
      return Promise.resolve(json({ page }));
    }
    if (url.endsWith("/wiki/pages/created") && method === "PATCH") {
      page = { ...page, ...(JSON.parse(String(options.body)) as object) };
      return Promise.resolve(json({ page }));
    }
    if (url.endsWith("/wiki/pages/created")) return Promise.resolve(json({ page }));
    if (url.endsWith("/wiki/pages")) return Promise.resolve(json({ pages: [] }));
    if (url.endsWith("/links")) return Promise.resolve(json({ links: [] }));
    if (url.includes("authoring-context")) return Promise.resolve(json({ context: {} }));
    return Promise.resolve(json({ habitat: { name: "Test" } }));
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/habitats/h/wiki?page=new"]}><Routes><Route path="/habitats/:habitatId/wiki" element={<WikiPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText("Page title…"), { target: { value: "A" } });
  fireEvent.change(screen.getByPlaceholderText("Write page content in markdown…"), { target: { value: "Body A" } });
  fireEvent.click(screen.getByRole("button", { name: "Create page" }));
  await waitFor(() => expect(writes.filter((w) => w.url.endsWith("/wiki/pages"))).toHaveLength(1));
  fireEvent.change(screen.getByPlaceholderText("Page title…"), { target: { value: "B" } });
  fireEvent.change(screen.getByPlaceholderText("Write page content in markdown…"), { target: { value: "Body B" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "published" } });
  fireEvent.change(screen.getByPlaceholderText("Add tag…"), { target: { value: "later" } });
  fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
  fireEvent.change(screen.getByPlaceholderText("Add tag…"), { target: { value: "unfinished" } });
  await act(async () => finish(json({ page })));
  expect(await screen.findByDisplayValue("Body B")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Page title…")).toHaveValue("B");
  expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
  expect(screen.getByText("#later")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Add tag…")).toHaveValue("unfinished");
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(writes.some((w) => w.url.endsWith("/created/versions") && w.method === "POST")).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "Save metadata" }));
  await waitFor(() => expect(writes.some((w) => w.url.endsWith("/created") && w.method === "PATCH")).toBe(true));
  expect(writes.filter((w) => w.url.endsWith("/wiki/pages"))).toEqual([{ url: "/api/habitats/h/wiki/pages", method: "POST", body: { title: "A", content: "Body A", parentId: null, tags: [], status: "draft" } }]);
  expect(writes.find((w) => w.url.endsWith("/created/versions"))?.body).toEqual({ title: "B", content: "Body B" });
  expect(writes.find((w) => w.method === "PATCH")?.body).toEqual({ parentId: null, tags: ["later"], status: "published" });
  client.clear();
});


it.each(["unchanged", "failed", "retired"] as const)("handles a %s create acknowledgement in the mounted page", async (outcome) => {
  let finish!: (response: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string, options: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/wiki/pages") && options.method === "POST") {
      writes.push(url);
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    if (url.endsWith("/wiki/pages/created")) return Promise.resolve(json({ page: initial }));
    if (url.endsWith("/wiki/pages")) return Promise.resolve(json({ pages: [] }));
    if (url.endsWith("/links")) return Promise.resolve(json({ links: [] }));
    if (url.includes("authoring-context")) return Promise.resolve(json({ context: {} }));
    return Promise.resolve(json({ habitat: { name: "Test" } }));
  }));
  function SwitchHabitat() {
    const navigate = useNavigate();
    return <button onClick={() => navigate("/habitats/h2/wiki?page=new")}>Switch Habitat</button>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/habitats/h/wiki?page=new"]}><SwitchHabitat /><Routes><Route path="/habitats/:habitatId/wiki" element={<WikiPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText("Page title…"), { target: { value: "A" } });
  fireEvent.change(screen.getByPlaceholderText("Write page content in markdown…"), { target: { value: "Body A" } });
  fireEvent.click(screen.getByRole("button", { name: "Create page" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  if (outcome === "failed") fireEvent.change(screen.getByPlaceholderText("Write page content in markdown…"), { target: { value: "Body B" } });
  if (outcome === "retired") {
    fireEvent.click(screen.getByRole("button", { name: "Switch Habitat" }));
    fireEvent.change(screen.getByPlaceholderText("Page title…"), { target: { value: "Other draft" } });
  }
  await act(async () => finish(outcome === "failed" ? json({ error: "Rejected" }, 400) : json({ page: initial })));
  if (outcome === "unchanged") {
    expect(await screen.findByText("Body A")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Page title…")).not.toBeInTheDocument();
  } else if (outcome === "failed") {
    await waitFor(() => expect(screen.getByRole("button", { name: "Create page" })).toBeEnabled());
    expect(screen.getByPlaceholderText("Write page content in markdown…")).toHaveValue("Body B");
  } else {
    expect(screen.getByPlaceholderText("Page title…")).toHaveValue("Other draft");
    expect(screen.getByRole("button", { name: "Create page" })).toBeInTheDocument();
  }
  expect(writes).toHaveLength(1);
  client.clear();
});
