import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MobileNav } from "./MobileNav.js";

function renderWithRouter(habitatId?: string) {
  return render(
    <MemoryRouter>
      <MobileNav
        onAddTask={vi.fn()}
        onStats={vi.fn()}
        onAgents={vi.fn()}
        onBoardSettings={vi.fn()}
        habitatId={habitatId}
      />
    </MemoryRouter>,
  );
}

describe("MobileNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Activity link to habitat activity route when habitat is in context", () => {
    renderWithRouter("hab-1");
    const activityLink = screen.getByText("Activity").closest("a");
    expect(activityLink).toBeTruthy();
    expect(activityLink!.getAttribute("href")).toBe("/habitats/hab-1/activity");
  });

  it("renders disabled Activity when no habitat is in context", () => {
    renderWithRouter(undefined);
    const activityItem = screen.getByText("Activity").closest("[aria-disabled]");
    expect(activityItem).toBeTruthy();
    expect(activityItem!.getAttribute("aria-disabled")).toBe("true");
  });

  it("Activity disabled entry is not a link", () => {
    renderWithRouter(undefined);
    const activityItems = screen.getAllByText("Activity");
    const activityItem = activityItems[0].closest("a");
    expect(activityItem).toBeNull();
  });
});
