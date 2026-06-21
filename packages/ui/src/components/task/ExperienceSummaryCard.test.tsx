import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceSummaryCard } from "./ExperienceSummaryCard.js";
import type { Pulse } from "../../types/index.js";

const listByMission = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    pulse: {
      listByMission: (...args: unknown[]) => listByMission(...args),
    },
  },
}));

function makePulse(overrides: Partial<Pulse> = {}): Pulse {
  return {
    id: "pulse-1",
    missionId: "mission-1",
    habitatId: "habitat-1",
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    toType: null,
    toId: null,
    signalType: "experience",
    subject: "Felt stuck on mocks",
    body: "The API mock shape was surprising.",
    taskId: "task-1",
    replyToId: null,
    linkedTaskId: null,
    metadata: { experience: "stuck", timing: "mid_task", implicit: true },
    createdAt: "2026-06-21T10:00:00.000Z",
    pinned: 0,
    isAuto: false,
    ...overrides,
  };
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExperienceSummaryCard
        taskId="task-1"
        missionId="mission-1"
        agents={[{ id: "agent-1", name: "Agent One" } as any]}
      />
    </QueryClientProvider>,
  );
}

describe("ExperienceSummaryCard", () => {
  beforeEach(() => {
    listByMission.mockResolvedValue({ items: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not render when the task has no experience signals", async () => {
    const { container } = renderCard();

    await waitFor(() => expect(listByMission).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders collapsed aggregate counts", async () => {
    listByMission.mockResolvedValue({
      items: [
        makePulse({ id: "p1", metadata: { experience: "stuck" } }),
        makePulse({ id: "p2", metadata: { experience: "confused" } }),
        makePulse({ id: "p3", metadata: { experience: "confused" } }),
      ],
      total: 3,
    });

    renderCard();

    expect(await screen.findByText("Agent experience: 3 signals")).toBeTruthy();
    expect(screen.getByText("1 stuck · 2 confused")).toBeTruthy();
    expect(screen.queryByText("Felt stuck on mocks")).toBeNull();
    expect(listByMission).toHaveBeenCalledWith("mission-1", {
      signalType: "experience",
      taskId: "task-1",
      limit: 200,
    });
  });

  it("expands to individual sorted signal cards", async () => {
    listByMission.mockResolvedValue({
      items: [
        makePulse({
          id: "older",
          subject: "Older smooth run",
          metadata: { experience: "smooth", timing: "completion" },
          createdAt: "2026-06-21T09:00:00.000Z",
        }),
        makePulse({
          id: "newer",
          subject: "Newer sidetrack",
          metadata: { experience: "sidetracked", timing: "mid_task" },
          createdAt: "2026-06-21T11:00:00.000Z",
        }),
      ],
      total: 2,
    });

    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /expand/i }));

    const cards = screen.getAllByRole("article");
    expect(cards[0]).toHaveTextContent("Newer sidetrack");
    expect(cards[0]).toHaveTextContent("sidetracked");
    expect(cards[0]).toHaveTextContent("mid-task");
    expect(cards[0]).toHaveTextContent("Posted by Agent One");
    expect(cards[1]).toHaveTextContent("Older smooth run");
  });
});
