import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Dialog, DialogTitle } from "./Dialog.js";

afterEach(() => {
  cleanup();
});

describe("Dialog — conditional render", () => {
  it("renders children when open=true", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Hello</DialogTitle>
        <p>Body content</p>
      </Dialog>,
    );
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <Dialog open={false} onClose={vi.fn()}>
        <DialogTitle>Hidden</DialogTitle>
        <p>Should not render</p>
      </Dialog>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.queryByText("Should not render")).toBeNull();
  });
});

describe("Dialog — a11y wiring", () => {
  it("has role='dialog' and aria-modal='true'", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>My Dialog</DialogTitle>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("wires aria-labelledby to the DialogTitle id", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Titled</DialogTitle>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const title = screen.getByText("Titled");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(labelledBy).toBe(title.id);
  });

  it("panel uses tabIndex=-1 to be programmatically focusable", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Focusable</DialogTitle>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("tabindex")).toBe("-1");
  });
});

describe("Dialog — escape closes", () => {
  it("fires onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose}>
        <DialogTitle>Esc me</DialogTitle>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClose for non-Escape keys", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose}>
        <DialogTitle>Other keys</DialogTitle>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Dialog — overlay click closes", () => {
  it("fires onClose when the overlay backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose}>
        <DialogTitle>Click backdrop</DialogTitle>
      </Dialog>,
    );
    // The backdrop is the first fixed overlay inside the dialog wrapper.
    const overlay = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog — focus trap (Tab / Shift+Tab)", () => {
  it("cycles to first focusable when Tab pressed from last", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Tab cycle</DialogTitle>
        <input data-testid="first" />
        <input data-testid="second" />
        <input data-testid="last" />
      </Dialog>,
    );
    const first = screen.getByTestId("first");
    const last = screen.getByTestId("last");
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("cycles to last focusable when Shift+Tab pressed from first", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Shift tab</DialogTitle>
        <input data-testid="first" />
        <input data-testid="last" />
      </Dialog>,
    );
    const first = screen.getByTestId("first");
    const last = screen.getByTestId("last");
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("Tab inside the panel does not move focus outside", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Inside</DialogTitle>
        <input data-testid="only" />
      </Dialog>,
    );
    const only = screen.getByTestId("only");
    only.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    // Should cycle back to the only focusable inside the panel.
    expect(document.activeElement).toBe(only);
  });
});

describe("Dialog — focus management on open", () => {
  it("focuses the panel when no focusable children exist", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>No focusables</DialogTitle>
        <p>Just text</p>
      </Dialog>,
    );
    // The Dialog moves focus via requestAnimationFrame.
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const dialog = screen.getByRole("dialog");
        expect(document.activeElement).toBe(dialog);
        resolve();
      });
    });
  });

  it("focuses the first focusable child when present", () => {
    render(
      <Dialog open onClose={vi.fn()}>
        <DialogTitle>Has focusable</DialogTitle>
        <button data-testid="primary">Primary</button>
        <button data-testid="other">Other</button>
      </Dialog>,
    );
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const primary = screen.getByTestId("primary");
        expect(document.activeElement).toBe(primary);
        resolve();
      });
    });
  });
});
