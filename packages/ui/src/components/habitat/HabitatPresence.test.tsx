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

  it("says N in habitat and labels viewers by name (human-only presence)", () => {
    render(
      <HabitatPresence
        presence={[
          entry({ sessionId: "s-1", type: "human", userName: "Ada" }),
          entry({ sessionId: "s-2", type: "human", userName: "Grace" }),
        ]}
      />,
    );

    expect(screen.getByText("2 in habitat")).toBeInTheDocument();
    expect(screen.queryByText(/viewing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/effort/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/presence time/i)).not.toBeInTheDocument();

    const ada = screen.getByLabelText("Ada");
    expect(ada).toBeInTheDocument();
    expect(screen.getByLabelText("Grace")).toBeInTheDocument();

    fireEvent.mouseEnter(ada.parentElement!);
    expect(screen.getByRole("tooltip", { name: "Ada" })).toBeInTheDocument();
  });
});
