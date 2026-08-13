import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import type { PresenceEntry } from "../../types/index.js";
import { HabitatPresence } from "./HabitatPresence.js";

function entry(overrides: Partial<PresenceEntry> & Pick<PresenceEntry, "sessionId" | "type">): PresenceEntry {
  return {
    habitatId: "h-1",
    lastSeen: 1,
    ...overrides,
  };
}

describe("HabitatPresence", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when the habitat has no live viewers", () => {
    const { container } = render(<HabitatPresence presence={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says N in habitat and distinguishes human vs agent viewers by name", () => {
    render(
      <HabitatPresence
        presence={[
          entry({ sessionId: "s-human", type: "human", userName: "Ada" }),
          entry({ sessionId: "s-agent", type: "agent", agentName: "Scout" }),
        ]}
      />,
    );

    expect(screen.getByText("2 in habitat")).toBeInTheDocument();
    expect(screen.queryByText(/viewing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/effort/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/presence time/i)).not.toBeInTheDocument();

    const human = screen.getByLabelText("Ada (human)");
    expect(human).toBeInTheDocument();
    expect(screen.getByLabelText("Scout (agent)")).toBeInTheDocument();

    fireEvent.mouseEnter(human.parentElement!);
    expect(screen.getByRole("tooltip", { name: "Ada (human)" })).toBeInTheDocument();
  });
});
