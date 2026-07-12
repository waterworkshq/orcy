import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Tooltip } from "./Tooltip.js";

afterEach(() => {
  cleanup();
});

describe("Tooltip — mouse hover", () => {
  it("hides tooltip content initially", () => {
    render(
      <Tooltip content="Hello tooltip">
        <button>Trigger</button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText("Hello tooltip")).toBeNull();
  });

  it("shows tooltip content on mouse enter", () => {
    render(
      <Tooltip content="Hello tooltip">
        <button>Trigger</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Trigger"));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByText("Hello tooltip")).toBeTruthy();
  });

  it("hides tooltip content on mouse leave", () => {
    render(
      <Tooltip content="Hello tooltip">
        <button>Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByText("Trigger");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText("Hello tooltip")).toBeNull();
  });
});

describe("Tooltip — keyboard accessibility", () => {
  it("shows tooltip on focus", () => {
    render(
      <Tooltip content="Focused">
        <button>Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByText("Trigger");
    trigger.focus();
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByText("Focused")).toBeTruthy();
  });

  it("hides tooltip on blur", () => {
    render(
      <Tooltip content="Blurred">
        <button>Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByText("Trigger");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText("Blurred")).toBeNull();
  });
});

describe("Tooltip — a11y wiring", () => {
  it("renders tooltip element with role='tooltip'", () => {
    render(
      <Tooltip content="A11y tip">
        <button>Trigger</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Trigger"));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toBeTruthy();
    expect(tooltip.getAttribute("role")).toBe("tooltip");
  });

  it("wires aria-describedby to the tooltip id when visible", () => {
    render(
      <Tooltip content="Described">
        <button>Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByText("Trigger");
    fireEvent.mouseEnter(trigger);
    const tooltip = screen.getByRole("tooltip");
    const describedBy = trigger.parentElement?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(describedBy).toBe(tooltip.id);
  });

  it("clears aria-describedby when hidden", () => {
    render(
      <Tooltip content="Described">
        <button>Trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByText("Trigger");
    expect(trigger.parentElement?.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("Tooltip — rendering", () => {
  it("renders wrapped children", () => {
    render(
      <Tooltip content="Ignored">
        <span data-testid="wrapped">Wrapped</span>
      </Tooltip>,
    );
    expect(screen.getByTestId("wrapped")).toBeTruthy();
    expect(screen.getByText("Wrapped")).toBeTruthy();
  });

  it("renders with no tooltipId leak across instances", () => {
    render(
      <>
        <Tooltip content="One">
          <button>First</button>
        </Tooltip>
        <Tooltip content="Two">
          <button>Second</button>
        </Tooltip>
      </>,
    );
    fireEvent.mouseEnter(screen.getByText("First"));
    fireEvent.mouseEnter(screen.getByText("Second"));
    const tooltips = screen.getAllByRole("tooltip");
    expect(tooltips.length).toBe(2);
    expect(tooltips[0].id).not.toBe(tooltips[1].id);
  });
});
