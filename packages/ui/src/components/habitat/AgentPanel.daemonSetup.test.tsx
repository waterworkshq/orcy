import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { AgentPanel } from "./AgentPanel.js";

const mockNotifyError = vi.fn();
const mockNotifySuccess = vi.fn();

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
    warning: vi.fn(),
  },
}));

type Call = { url: string; method: string; body?: Record<string, unknown> };

const calls: Call[] = [];
let detectResults: Array<() => Response | Promise<Response>> = [];
let registerResult: (() => Response | Promise<Response>) | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const habitat = { id: "board-1", name: "Test Habitat", description: "" };

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({
    url,
    method,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  });
  const path = url.replace("/api", "").split("?")[0];
  if (path === "/daemons/detect-clis") {
    const next = detectResults.shift();
    if (!next) throw new Error("no queued detect response");
    return next();
  }
  if (path === "/daemons/register") {
    return registerResult
      ? registerResult()
      : json({
          daemonId: "daemon-1",
          agents: [{ id: "agent-1", name: "Agent Alpha", type: "claude-code", apiKey: "k" }],
        });
  }
  if (path === "/daemons") return json({ daemons: [] });
  if (path === "/habitats/board-1/agent-quality") {
    return json({ habitatId: "board-1", generatedAt: "2026-01-01T00:00:00.000Z", signals: [] });
  }
  if (path === "/habitats/board-1/agent-messages") return json({ messages: [], total: 0 });
  if (path === "/habitats/board-1") return json({ habitat, columns: [], missions: [] });
  if (path === "/agents") return json({ agents: [] });
  return json({});
});

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentPanel habitatId="board-1" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

const detectCalls = () => calls.filter((c) => c.url.includes("/daemons/detect-clis"));
const registerCalls = () => calls.filter((c) => c.url.includes("/daemons/register"));
const startCalls = () => calls.filter((c) => /\/daemons\/[^/]+\/start/.test(c.url));

async function openWizard() {
  fireEvent.click(await screen.findByRole("button", { name: /set up autonomous mode/i }));
  return screen.findByRole("button", { name: /^detect clis$/i });
}

describe("daemon setup wizard detection recovery", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    calls.length = 0;
    detectResults = [];
    registerResult = undefined;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("retries detection in the same mounted wizard and proceeds once a CLI appears", async () => {
    detectResults = [
      () => json({ clis: [] }),
      () => json({ clis: [{ type: "claude-code", version: "1.2.3", path: "/usr/bin/claude" }] }),
    ];
    renderPanel();

    fireEvent.click(await openWizard());
    await waitFor(() => expect(detectCalls()).toHaveLength(1));

    // An empty detection leaves the wizard on the detect step, still able to
    // run detection again — no dead end with a disabled registration.
    expect(await screen.findByText(/no clis detected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register daemon/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^detect clis$/i }));
    await waitFor(() => expect(detectCalls()).toHaveLength(2));
    expect(await screen.findByText("claude-code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /register daemon/i })).toBeEnabled();
    expect(registerCalls()).toHaveLength(0);
  });

  it("keeps a non-empty first detection working and registers exactly once", async () => {
    detectResults = [
      () => json({ clis: [{ type: "codex", version: "0.9.0", path: "/usr/bin/codex" }] }),
    ];
    renderPanel();

    fireEvent.click(await openWizard());
    expect(await screen.findByText("codex")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /register daemon/i }));
    await waitFor(() => expect(registerCalls()).toHaveLength(1));
    expect(registerCalls()[0].body).toEqual({
      name: "local-daemon",
      habitatIds: ["board-1"],
      maxConcurrent: 4,
    });
    expect(await screen.findByText(/registered agents/i)).toBeInTheDocument();
    // The wizard stops at the registered-agents step; nothing is launched.
    expect(startCalls()).toHaveLength(0);
  });

  it("does not stay stuck after cancel and reopen", async () => {
    detectResults = [
      () => json({ clis: [] }),
      () => json({ clis: [{ type: "claude-code", version: "1.2.3", path: "/usr/bin/claude" }] }),
    ];
    renderPanel();

    fireEvent.click(await openWizard());
    await waitFor(() => expect(detectCalls()).toHaveLength(1));
    expect(await screen.findByText(/no clis detected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/no clis detected/i)).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: /set up autonomous mode/i }));
    fireEvent.click(await screen.findByRole("button", { name: /detect/i }));
    await waitFor(() => expect(detectCalls()).toHaveLength(2));
    expect(await screen.findByText("claude-code")).toBeInTheDocument();
  });

  it("surfaces a detector failure and stays retryable", async () => {
    detectResults = [
      () => json({ error: "Detection failed" }, 500),
      () => json({ clis: [{ type: "claude-code", version: "1.2.3", path: "/usr/bin/claude" }] }),
    ];
    renderPanel();

    fireEvent.click(await openWizard());
    await waitFor(() => expect(mockNotifyError).toHaveBeenCalledWith("Detection failed"));
    expect(screen.queryByText(/detected clis/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^detect clis$/i }));
    await waitFor(() => expect(detectCalls()).toHaveLength(2));
    expect(await screen.findByText("claude-code")).toBeInTheDocument();
    expect(registerCalls()).toHaveLength(0);
  });

  it("does not fire a second detection while one is in flight", async () => {
    let releaseDetect: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      releaseDetect = () =>
        resolve(json({ clis: [{ type: "claude-code", version: "1.2.3", path: "/usr/bin/claude" }] }));
    });
    detectResults = [() => pending];
    renderPanel();

    fireEvent.click(await openWizard());
    await waitFor(() => expect(detectCalls()).toHaveLength(1));
    expect(screen.getByRole("button", { name: /^detect clis$/i })).toBeDisabled();

    releaseDetect?.();
    expect(await screen.findByText("claude-code")).toBeInTheDocument();
    expect(detectCalls()).toHaveLength(1);
    expect(registerCalls()).toHaveLength(0);
  });

  it("does not register twice when the wizard is closed mid-registration", async () => {
    let releaseRegister: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      releaseRegister = () =>
        resolve(
          json({
            daemonId: "daemon-1",
            agents: [{ id: "agent-1", name: "Agent Alpha", type: "claude-code", apiKey: "k" }],
          }),
        );
    });
    detectResults = [
      () => json({ clis: [{ type: "claude-code", version: "1.2.3", path: "/usr/bin/claude" }] }),
    ];
    registerResult = () => pending;
    renderPanel();

    fireEvent.click(await openWizard());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /register daemon/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /register daemon/i }));
    await waitFor(() => expect(registerCalls()).toHaveLength(1));

    // Closing mid-registration must not re-enable registration for the same
    // daemon when the wizard is reopened.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /set up autonomous mode/i }));
    const register = await screen.findByRole("button", { name: /register daemon/i });
    expect(register).toBeDisabled();
    fireEvent.click(register);
    expect(registerCalls()).toHaveLength(1);

    releaseRegister?.();
  });

  it("ignores a detection response that resolves after the wizard was closed", async () => {
    let releaseDetect: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      releaseDetect = () =>
        resolve(json({ clis: [{ type: "claude-code", version: "1.2.3", path: "/usr/bin/claude" }] }));
    });
    detectResults = [() => pending];
    renderPanel();

    fireEvent.click(await openWizard());
    await waitFor(() => expect(detectCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    releaseDetect?.();
    await waitFor(() => expect(detectCalls()).toHaveLength(1));

    fireEvent.click(await screen.findByRole("button", { name: /set up autonomous mode/i }));
    // The retired response must not have moved the reopened wizard forward.
    expect(screen.queryByText("claude-code")).toBeNull();
    expect(screen.getByRole("button", { name: /detect/i })).toBeEnabled();
  });
});
