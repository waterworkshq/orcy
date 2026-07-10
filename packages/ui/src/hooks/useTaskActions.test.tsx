import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { useTaskActions } from "./useTaskActions.js";

vi.mock("../api/index.js", () => ({
  api: {
    tasks: {
      delete: vi.fn(),
      clone: vi.fn(),
    },
  },
}));

vi.mock("../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

/** Tiny test harness that exposes the hook's actions as buttons for fireEvent. */
function Harness({ task }: { task: { id: string } | undefined }) {
  const { deleteDialogOpen, setDeleteDialogOpen, handleDelete, handleClone } =
    useTaskActions(task);
  return (
    <div>
      <button data-testid="delete-btn" onClick={() => void handleDelete()}>
        Delete
      </button>
      <button data-testid="clone-btn" onClick={() => void handleClone()}>
        Clone
      </button>
      <span data-testid="dialog-open">{String(deleteDialogOpen)}</span>
      <button data-testid="set-dialog-true" onClick={() => setDeleteDialogOpen(true)}>
        Open
      </button>
      <button data-testid="set-dialog-false" onClick={() => setDeleteDialogOpen(false)}>
        Close
      </button>
    </div>
  );
}

describe("useTaskActions — delete + clone toast feedback", () => {
  it("successful delete → api.tasks.delete called with id and notify.success fires", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");
    vi.mocked(api.tasks.delete).mockResolvedValueOnce(undefined);

    render(<Harness task={{ id: "task-1" }} />);
    fireEvent.click(screen.getByTestId("delete-btn"));

    await waitFor(() => {
      expect(api.tasks.delete).toHaveBeenCalledTimes(1);
    });
    expect(api.tasks.delete).toHaveBeenCalledWith("task-1");
    expect(notify.success).toHaveBeenCalledWith("Task deleted");
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("successful clone → api.tasks.clone called with id and notify.success fires", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");
    vi.mocked(api.tasks.clone).mockResolvedValueOnce({ task: { id: "cloned-1" } } as never);

    render(<Harness task={{ id: "task-7" }} />);
    fireEvent.click(screen.getByTestId("clone-btn"));

    await waitFor(() => {
      expect(api.tasks.clone).toHaveBeenCalledTimes(1);
    });
    expect(api.tasks.clone).toHaveBeenCalledWith("task-7");
    expect(notify.success).toHaveBeenCalledWith("Task cloned");
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("delete failure → notify.error called with Error message, success NOT called", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");
    vi.mocked(api.tasks.delete).mockRejectedValueOnce(new Error("Network down"));

    render(<Harness task={{ id: "task-1" }} />);
    fireEvent.click(screen.getByTestId("delete-btn"));

    await waitFor(() => {
      expect(api.tasks.delete).toHaveBeenCalledTimes(1);
    });
    expect(notify.error).toHaveBeenCalledWith("Network down");
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("clone failure → notify.error called with Error message, success NOT called", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");
    vi.mocked(api.tasks.clone).mockRejectedValueOnce(new Error("Forbidden"));

    render(<Harness task={{ id: "task-2" }} />);
    fireEvent.click(screen.getByTestId("clone-btn"));

    await waitFor(() => {
      expect(api.tasks.clone).toHaveBeenCalledTimes(1);
    });
    expect(notify.error).toHaveBeenCalledWith("Forbidden");
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("delete with undefined task → no api call, no notify call", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");

    render(<Harness task={undefined} />);
    fireEvent.click(screen.getByTestId("delete-btn"));

    // Allow microtasks (the try block in handleDelete runs synchronously after the guard
    // so by this point any notify call would have happened).
    await waitFor(() => {
      expect(api.tasks.delete).not.toHaveBeenCalled();
    });
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("clone with undefined task → no api call, no notify call", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");

    render(<Harness task={undefined} />);
    fireEvent.click(screen.getByTestId("clone-btn"));

    await waitFor(() => {
      expect(api.tasks.clone).not.toHaveBeenCalled();
    });
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("deleteDialogOpen state toggles via setters", () => {
    render(<Harness task={{ id: "task-9" }} />);
    expect(screen.getByTestId("dialog-open").textContent).toBe("false");

    fireEvent.click(screen.getByTestId("set-dialog-true"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("true");

    fireEvent.click(screen.getByTestId("set-dialog-false"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("false");
  });
});
