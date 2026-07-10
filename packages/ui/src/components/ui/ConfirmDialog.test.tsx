import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";

afterEach(() => {
  cleanup();
});

describe("ConfirmDialog — variant mapping and wiring", () => {
  it("confirm button uses destructive styling when variant='danger'", () => {
    const { container } = render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="Delete this?"
        description="This cannot be undone."
        variant="danger"
        confirmLabel="Delete"
      />,
    );

    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    // destructive variant from Button.tsx adds `bg-destructive text-destructive-foreground`.
    expect(confirmBtn.className).toMatch(/bg-destructive/);
    expect(confirmBtn.className).toMatch(/text-destructive-foreground/);
    // Sanity: ensure dialog body and footer rendered.
    expect(container.textContent).toContain("Delete this?");
    expect(container.textContent).toContain("This cannot be undone.");
  });

  it("default variant does NOT use destructive styling", () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="Confirm"
        description="Are you sure?"
        confirmLabel="OK"
      />,
    );

    const confirmBtn = screen.getByRole("button", { name: "OK" });
    expect(confirmBtn.className).not.toMatch(/bg-destructive/);
  });

  it("warning variant still uses default button styling (not destructive)", () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="Heads up"
        description="This is a warning."
        variant="warning"
        confirmLabel="Continue"
      />,
    );

    const confirmBtn = screen.getByRole("button", { name: "Continue" });
    expect(confirmBtn.className).not.toMatch(/bg-destructive/);
  });

  it("falls back to 'Confirm' for confirmLabel when not provided", () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="t"
        description="d"
      />,
    );

    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("falls back to 'Cancel' for cancelLabel when not provided", () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="t"
        description="d"
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("uses provided confirmLabel/cancelLabel when supplied", () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="t"
        description="d"
        confirmLabel="Yes, do it"
        cancelLabel="Nope"
      />,
    );

    expect(screen.getByRole("button", { name: "Yes, do it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nope" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("onConfirm fires when confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        title="t"
        description="d"
        confirmLabel="Confirm"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("onCancel fires when cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={onCancel}
        title="t"
        description="d"
        cancelLabel="Cancel"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not render anything when open=false", () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="Hidden"
        description="Should not appear."
      />,
    );

    // Dialog returns null when closed — nothing rendered.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
  });
});
