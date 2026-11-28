import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LearningLoopTab } from "./LearningLoopTab.js";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LearningLoopTab habitatId="hab-1" /></QueryClientProvider>);
  return client;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Learning Loop read feedback", () => {
  it("shows unavailable policies and allows retry while history remains usable", async () => {
    let policyFails = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/policies")) {
        return policyFails
          ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
          : Response.json({ policies: [] });
      }
      if (url.endsWith("/runs")) return Response.json({ runs: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    mount();
    expect(await screen.findByText(/policies unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Disabled \(off by default\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No extraction policies configured/)).not.toBeInTheDocument();
    expect(await screen.findByText(/No extraction runs recorded/)).toBeInTheDocument();
    policyFails = false;
    fireEvent.click(screen.getByRole("button", { name: /retry policies/i }));
    expect(await screen.findByText(/No extraction policies configured/)).toBeInTheDocument();
  });

  it("shows unavailable history and allows retry while policies remain usable", async () => {
    let historyFails = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/policies")) return Response.json({ policies: [{
        id: "p1", extractorKey: "pattern", enabled: true, sourceTypes: ["tasks"],
        schedule: "daily", windowSeconds: 60, lookbackSeconds: 3600,
        minConfidence: null, minSampleSize: null, version: 1,
      }] });
      if (url.endsWith("/runs")) return historyFails
        ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
        : Response.json({ runs: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    mount();
    expect(await screen.findByText(/history unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No extraction runs recorded/)).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /ensure run for pattern/i })).toBeEnabled();
    historyFails = false;
    fireEvent.click(screen.getByRole("button", { name: /retry history/i }));
    expect(await screen.findByText(/No extraction runs recorded/)).toBeInTheDocument();
  });

  it("labels retained policy and history data after failed refreshes and recovers", async () => {
    let fail = false;
    const policy = {
      id: "p1", extractorKey: "pattern", enabled: true, sourceTypes: ["tasks"],
      schedule: "daily", windowSeconds: 60, lookbackSeconds: 3600,
      minConfidence: null, minSampleSize: null, version: 1,
    };
    const run = {
      id: "r1", extractorKey: "pattern", status: "completed", deliveryMode: "manual",
      candidateCount: 1, persistedCount: 1, deduplicatedCount: 0, completedAt: null, error: null,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (fail) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
      if (url.endsWith("/policies")) return Response.json({ policies: [policy] });
      if (url.endsWith("/runs")) return Response.json({ runs: [run] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = mount();
    expect(await screen.findByText(/Learning Loop: Enabled/)).toBeInTheDocument();
    expect(await screen.findByTestId("run-r1")).toBeInTheDocument();
    fail = true;
    await act(async () => { await client.invalidateQueries(); });
    expect(await screen.findByText(/last loaded policies; they may be out of date/i)).toBeInTheDocument();
    expect(screen.getByText(/last loaded history; it may be out of date/i)).toBeInTheDocument();
    expect(screen.getByTestId("policy-p1")).toBeInTheDocument();
    expect(screen.getByTestId("run-r1")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /retry policies/i }));
    fireEvent.click(screen.getByRole("button", { name: /retry history/i }));
    expect(await screen.findByText(/Learning Loop: Enabled/)).toBeInTheDocument();
    await screen.findByTestId("run-r1");
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
