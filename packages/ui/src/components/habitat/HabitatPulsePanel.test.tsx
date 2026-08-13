import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HabitatPulsePanel } from "./HabitatPulsePanel.js";

const listByHabitat = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    pulse: {
      listByHabitat: (...args: unknown[]) => listByHabitat(...args),
    },
  },
}));

vi.mock("./PulseSignalCard.js", () => ({
  PulseSignalCard: () => <div data-testid="pulse-signal-card" />,
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HabitatPulsePanel habitatId="habitat-1" />
    </QueryClientProvider>,
  );
}

describe("HabitatPulsePanel", () => {
  beforeEach(() => {
    listByHabitat.mockResolvedValue({ items: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps Habitat Signals and states the board is shared by humans and agents", async () => {
    renderPanel();

    await waitFor(() => {
      expect(listByHabitat).toHaveBeenCalled();
    });

    expect(screen.getByText("Habitat Signals")).toBeInTheDocument();
    expect(screen.getByText(/shared by humans and agents/i)).toBeInTheDocument();
    expect(screen.queryByText(/chat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/channel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/notification/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/toast/i)).not.toBeInTheDocument();
  });
});
