import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { PulseSignalCard } from "./PulseSignalCard.js";
import type { Pulse } from "../../types/index.js";

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
    subject: "Agent got stuck on mocks",
    body: "The test double shape was unclear.",
    taskId: "task-1",
    replyToId: null,
    linkedTaskId: "task-1",
    metadata: { experience: "stuck", timing: "mid_task", implicit: true },
    createdAt: "2026-06-21T10:00:00.000Z",
    pinned: 0,
    isAuto: false,
    ...overrides,
  };
}

function renderCard(pulse: Pulse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PulseSignalCard pulse={pulse} missionId="mission-1" />
    </QueryClientProvider>,
  );
}

describe("PulseSignalCard", () => {
  afterEach(cleanup);

  it("visually labels experience category and linked task", () => {
    renderCard(makePulse());

    expect(screen.getByText("Experience")).toBeTruthy();
    expect(screen.getByText("stuck")).toBeTruthy();
    expect(screen.getByText("Agent got stuck on mocks")).toBeTruthy();
    expect(screen.getByText("Task: task-1")).toBeTruthy();
  });
});
