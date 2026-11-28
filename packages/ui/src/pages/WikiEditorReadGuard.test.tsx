import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WikiPage } from "./WikiPage.js";

const page = { id: "p1", habitatId: "h1", title: "Original", content: "Existing body", parentId: "parent", tags: ["kept"], status: "published", currentVersionNumber: 1, updatedAt: "2026-01-01T00:00:00Z", links: [] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("blocks a cold failed detail read and retries before permitting writes", async () => {
  let fail = true;
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (options?.method === "POST" || options?.method === "PATCH") return json({ page });
    if (path.endsWith("/wiki/pages/p1") && !options?.method) return fail ? json({ error: "unavailable" }, 503) : json({ page });
    if (path.endsWith("/api/habitats/h1")) return json({ habitat: { name: "Habitat" } });
    if (path.endsWith("/wiki/pages")) return json({ pages: [] });
    return json({ links: [], context: {} });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/habitats/h1/wiki?page=p1&edit=true"]}><Routes><Route path="/habitats/:habitatId/wiki" element={<WikiPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  expect((await screen.findByRole("alert")).textContent).toMatch(/failed to load/i);
  expect(screen.queryByPlaceholderText("Page title…")).toBeNull();
  expect(fetcher.mock.calls.filter(([, options]) => options?.method && options.method !== "GET")).toHaveLength(0);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  await waitFor(() => expect((screen.getByPlaceholderText("Page title…") as HTMLInputElement).value).toBe("Original"));
  expect((screen.getByPlaceholderText("Write page content in markdown…") as HTMLTextAreaElement).value).toBe("Existing body");
  fireEvent.change(screen.getByPlaceholderText("Page title…"), { target: { value: "Changed title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
  const version = fetcher.mock.calls.find(([, options]) => options?.method === "POST")![1]!;
  expect(JSON.parse(version.body as string)).toMatchObject({ title: "Changed title", content: "Existing body" });
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
  const metadata = fetcher.mock.calls.find(([, options]) => options?.method === "PATCH")![1]!;
  expect(JSON.parse(metadata.body as string)).toEqual({ parentId: "parent", tags: ["kept"], status: "draft" });
});

it("allows a genuinely empty loaded body and retains a draft after a failed refresh", async () => {
  let fail = false;
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (options?.method === "POST") return json({ page: { ...page, content: "" } });
    if (path.endsWith("/wiki/pages/p1")) return fail ? json({ error: "unavailable" }, 503) : json({ page: { ...page, content: "" } });
    if (path.endsWith("/api/habitats/h1")) return json({ habitat: { name: "Habitat" } });
    if (path.endsWith("/wiki/pages")) return json({ pages: [] });
    return json({ links: [], context: {} });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/habitats/h1/wiki?page=p1&edit=true"]}><Routes><Route path="/habitats/:habitatId/wiki" element={<WikiPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect((screen.getByPlaceholderText("Page title…") as HTMLInputElement).value).toBe("Original"));
  fireEvent.change(screen.getByPlaceholderText("Page title…"), { target: { value: "Draft title" } });
  fail = true;
  await client.invalidateQueries({ queryKey: ["wiki", "page", "h1", "p1"], exact: true });
  expect((screen.getByPlaceholderText("Page title…") as HTMLInputElement).value).toBe("Draft title");
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
  expect(JSON.parse(fetcher.mock.calls.find(([, options]) => options?.method === "POST")![1]!.body as string)).toMatchObject({ title: "Draft title", content: "" });
});
