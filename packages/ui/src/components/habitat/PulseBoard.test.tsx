import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PulseBoard } from "./PulseBoard.js";

const listByMission = vi.fn();
const me = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    auth: {
      me: (...args: unknown[]) => me(...args),
    },
    pulse: {
      listByMission: (...args: unknown[]) => listByMission(...args),
    },
  },
}));

vi.mock("./PulseTimeline.js", () => ({
  PulseTimeline: () => <div data-testid="pulse-timeline" />,
}));

vi.mock("./PulseComposeDialog.js", () => ({
  PulseComposeDialog: () => null,
}));

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PulseBoard missionId="mission-1" />
    </QueryClientProvider>,
  );
}

describe("PulseBoard", () => {
  beforeEach(() => {
    me.mockResolvedValue({ user: { id: "u1", username: "agent", role: "agent" } });
    listByMission.mockResolvedValue({ items: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides experience signals by default for agents", async () => {
    renderBoard();

    await waitFor(() => {
      expect(listByMission).toHaveBeenLastCalledWith(
        "mission-1",
        expect.objectContaining({ signalTypes: expect.not.stringContaining("experience") }),
      );
    });
  });

  it("includes experience signals when the filter is toggled on", async () => {
    renderBoard();

    await waitFor(() => {
      expect(listByMission).toHaveBeenLastCalledWith(
        "mission-1",
        expect.objectContaining({ signalTypes: expect.not.stringContaining("experience") }),
      );
    });

    const toggle = await screen.findByRole("button", { name: /show experience signals/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(listByMission).toHaveBeenLastCalledWith(
        "mission-1",
        expect.not.objectContaining({ signalTypes: expect.any(String) }),
      );
    });
  });
});
