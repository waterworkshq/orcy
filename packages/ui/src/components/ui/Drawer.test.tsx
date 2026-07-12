import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Drawer } from "./Drawer.js";

afterEach(() => {
  cleanup();
});

describe("Drawer — conditional render", () => {
  it("renders children when open=true", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <h2 id="title">Drawer Title</h2>
        <p>Drawer body</p>
      </Drawer>,
    );
    expect(screen.getByText("Drawer Title")).toBeTruthy();
    expect(screen.getByText("Drawer body")).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <Drawer open={false} onClose={vi.fn()}>
        <h2>Hidden</h2>
      </Drawer>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
  });
});

describe("Drawer — a11y wiring", () => {
  it("has role='dialog' and aria-modal='true'", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <h2 id="title">Modal-ish</h2>
      </Drawer>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
  });

  it("uses aria-labelledby from prop when provided", () => {
    render(
      <Drawer open onClose={vi.fn()} aria-labelledby="custom-title-id">
        <h2 id="custom-title-id">Labelled</h2>
      </Drawer>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("aria-labelledby")).toBe("custom-title-id");
  });

  it("auto-generates an aria-labelledby when not provided", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <h2>Generated</h2>
      </Drawer>,
    );
    const panel = screen.getByRole("dialog");
    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(labelledBy!.length).toBeGreaterThan(0);
  });

  it("panel is programmatically focusable (tabIndex=-1)", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <h2>Focusable</h2>
      </Drawer>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("tabindex")).toBe("-1");
  });
});

describe("Drawer — escape closes", () => {
  it("fires onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose}>
        <h2>Esc me</h2>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClose for non-Escape keys", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose}>
        <h2>Other keys</h2>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: " " });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Drawer — overlay click closes", () => {
  it("fires onClose when backdrop overlay is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Drawer open onClose={onClose}>
        <h2>Backdrop click</h2>
      </Drawer>,
    );
    const overlay = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Drawer — focus management", () => {
  it("focuses the panel when no focusable children exist", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <p>Plain text only</p>
      </Drawer>,
    );
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const panel = screen.getByRole("dialog");
        expect(document.activeElement).toBe(panel);
        resolve();
      });
    });
  });

  it("focuses the first focusable child when present", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <button data-testid="primary">Primary Action</button>
        <button data-testid="secondary">Other</button>
      </Drawer>,
    );
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const primary = screen.getByTestId("primary");
        expect(document.activeElement).toBe(primary);
        resolve();
      });
    });
  });

  it("cycles focus forward (Tab on last wraps to first)", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <input data-testid="first" />
        <input data-testid="last" />
      </Drawer>,
    );
    const last = screen.getByTestId("last");
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("first"));
  });

  it("cycles focus backward (Shift+Tab on first wraps to last)", () => {
    render(
      <Drawer open onClose={vi.fn()}>
        <input data-testid="first" />
        <input data-testid="last" />
      </Drawer>,
    );
    screen.getByTestId("first").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("last"));
  });
});
