import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { HabitatAgentMailInbox } from "./HabitatAgentMailInbox.js";
import type { HabitatAgentMail } from "../../api/domains/agentMail.js";

const mockListByHabitat = vi.fn();
const mockAgentsListWithTasks = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    agentMail: {
      listByHabitat: (...args: unknown[]) => mockListByHabitat(...args),
    },
  },
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgentsListWithTasks: (...args: unknown[]) => mockAgentsListWithTasks(...args),
}));

function mail(overrides: Partial<HabitatAgentMail> = {}): HabitatAgentMail {
  return {
    id: "m1",
    habitatId: "board-1",
    fromAgentId: "agent-1",
    toAgentId: "agent-2",
    taskId: null,
    subject: "retry failed",
    body: "SECRET_STACK_DUMP",
    messageType: "info",
    priority: "normal",
    readAt: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HabitatAgentMailInbox habitatId="board-1" />
    </QueryClientProvider>,
  );
}

describe("HabitatAgentMailInbox", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockAgentsListWithTasks.mockReturnValue({
      data: [
        { agent: { id: "agent-1", name: "Scout" } },
        { agent: { id: "agent-2", name: "Forge" } },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows agent mail bodies and recipient unread metadata", async () => {
    mockListByHabitat.mockResolvedValue({ messages: [mail()], total: 1 });
    renderInbox();
    expect(await screen.findByText("retry failed")).toBeInTheDocument();
    expect(screen.getByText("Agent mail")).toBeInTheDocument();
    expect(screen.getByText("SECRET_STACK_DUMP")).toBeInTheDocument();
    expect(screen.getByText("Scout → Forge")).toBeInTheDocument();
    expect(screen.getByText("Recipient unread")).toBeInTheDocument();
    expect(screen.queryByText(/chat/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Reply on Pulse/i)).toBeInTheDocument();
  });

  it("shows empty copy when the habitat has no mail", async () => {
    mockListByHabitat.mockResolvedValue({ messages: [], total: 0 });
    renderInbox();
    expect(await screen.findByText("No agent mail in this habitat.")).toBeInTheDocument();
  });

  it("surfaces load errors", async () => {
    mockListByHabitat.mockRejectedValue(new Error("forbidden"));
    renderInbox();
    expect(await screen.findByText(/Failed to load agent mail: forbidden/)).toBeInTheDocument();
  });
});
