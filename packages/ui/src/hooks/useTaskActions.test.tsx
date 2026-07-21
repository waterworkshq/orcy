import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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
  const {
    deleteDialogOpen,
    setDeleteDialogOpen,
    handleDelete,
    handleClone,
    cloneDialogOpen,
    setCloneDialogOpen,
    handleLegacyClone,
  } = useTaskActions(task);
  return (
    <div>
      <button data-testid="delete-btn" onClick={() => void handleDelete()}>
        Delete
      </button>
      <button data-testid="clone-btn" onClick={() => void handleClone()}>
        Clone
      </button>
      <button data-testid="legacy-clone-btn" onClick={() => void handleLegacyClone()}>
        Legacy clone
      </button>
      <span data-testid="dialog-open">{String(deleteDialogOpen)}</span>
      <span data-testid="clone-dialog-open">{String(cloneDialogOpen)}</span>
      <button data-testid="set-dialog-true" onClick={() => setDeleteDialogOpen(true)}>
        Open delete
      </button>
      <button data-testid="set-dialog-false" onClick={() => setDeleteDialogOpen(false)}>
        Close delete
      </button>
      <button data-testid="set-clone-dialog-true" onClick={() => setCloneDialogOpen(true)}>
        Open clone
      </button>
      <button data-testid="set-clone-dialog-false" onClick={() => setCloneDialogOpen(false)}>
        Close clone
      </button>
    </div>
  );
}

describe("useTaskActions — delete + clone-preparation dialog state", () => {
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

  it("handleClone → opens the clone-preparation dialog (T11 Phase 2)", async () => {
    const { api } = await import("../api/index.js");
    render(<Harness task={{ id: "task-7" }} />);

    // The clone trigger OPENS the prepare-edit-publish dialog instead of
    // firing an immediate `api.tasks.clone` (T11 Phase 2 — the legacy
    // immediate clone is preserved as a 404 fallback inside the dialog).
    expect(screen.getByTestId("clone-dialog-open").textContent).toBe("false");
    fireEvent.click(screen.getByTestId("clone-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("clone-dialog-open").textContent).toBe("true");
    });
    // The new flow does NOT call api.tasks.clone directly — the dialog does.
    expect(api.tasks.clone).not.toHaveBeenCalled();
  });

  it("handleLegacyClone → fires the legacy immediate clone (404 fallback)", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");
    vi.mocked(api.tasks.clone).mockResolvedValueOnce({ task: { id: "cloned-1" } } as never);

    render(<Harness task={{ id: "task-7" }} />);
    fireEvent.click(screen.getByTestId("legacy-clone-btn"));

    await waitFor(() => {
      expect(api.tasks.clone).toHaveBeenCalledTimes(1);
    });
    expect(api.tasks.clone).toHaveBeenCalledWith("task-7");
    expect(notify.success).toHaveBeenCalledWith("Task cloned");
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("handleLegacyClone failure → notify.error called with Error message", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");
    vi.mocked(api.tasks.clone).mockRejectedValueOnce(new Error("Forbidden"));

    render(<Harness task={{ id: "task-2" }} />);
    fireEvent.click(screen.getByTestId("legacy-clone-btn"));

    await waitFor(() => {
      expect(api.tasks.clone).toHaveBeenCalledTimes(1);
    });
    expect(notify.error).toHaveBeenCalledWith("Forbidden");
    expect(notify.success).not.toHaveBeenCalled();
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

  it("handleClone with undefined task → no dialog open, no api call", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");

    render(<Harness task={undefined} />);
    fireEvent.click(screen.getByTestId("clone-btn"));

    await waitFor(() => {
      expect(api.tasks.clone).not.toHaveBeenCalled();
    });
    expect(screen.getByTestId("clone-dialog-open").textContent).toBe("false");
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("handleLegacyClone with undefined task → no api call, no notify call", async () => {
    const { api } = await import("../api/index.js");
    const { notify } = await import("../lib/toast.js");

    render(<Harness task={undefined} />);
    fireEvent.click(screen.getByTestId("legacy-clone-btn"));

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

  it("cloneDialogOpen state toggles via setters", () => {
    render(<Harness task={{ id: "task-9" }} />);
    expect(screen.getByTestId("clone-dialog-open").textContent).toBe("false");

    fireEvent.click(screen.getByTestId("set-clone-dialog-true"));
    expect(screen.getByTestId("clone-dialog-open").textContent).toBe("true");

    fireEvent.click(screen.getByTestId("set-clone-dialog-false"));
    expect(screen.getByTestId("clone-dialog-open").textContent).toBe("false");
  });
});