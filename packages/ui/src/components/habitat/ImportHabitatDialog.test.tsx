import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ImportHabitatDialog } from "./ImportHabitatDialog.js";

const mockImport = vi.fn();
const mockImportInto = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: {
      import: (...args: unknown[]) => mockImport(...args),
      importInto: (...args: unknown[]) => mockImportInto(...args),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
    warning: vi.fn(),
  },
}));

vi.mock("../ui/Dialog.js", () => ({
  Dialog: ({ open, children }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("../ui/Button.js", () => ({
  Button: ({ children, onClick, disabled, loading }: any) => (
    <button onClick={onClick} disabled={disabled || loading}>
      {loading ? "Loading..." : children}
    </button>
  ),
}));

const v1Fixture = {
  version: 1,
  exportedAt: "2024-01-01T00:00:00Z",
  board: {
    name: "Legacy Board",
    description: "A v1 export",
    columns: [
      {
        name: "Todo",
        order: 0,
        wipLimit: null,
        autoAdvance: false,
        requiresClaim: false,
        nextColumnName: null,
        isTerminal: false,
      },
    ],
    features: [
      {
        title: "Legacy Feature 1",
        description: "First legacy feature",
        acceptanceCriteria: "AC1",
        priority: "high",
        labels: ["legacy"],
        columnName: "Todo",
        status: "backlog",
        dependsOn: [],
        blocks: [],
        dueAt: null,
        tasks: [
          {
            title: "Task 1",
            description: "",
            priority: "medium",
            status: "todo",
            requiredDomain: null,
            requiredCapabilities: [],
            result: null,
            artifacts: [],
            createdBy: "human",
          },
        ],
      },
      {
        title: "Legacy Feature 2",
        description: "Second legacy feature",
        acceptanceCriteria: "",
        priority: "medium",
        labels: [],
        columnName: "Todo",
        status: "in_progress",
        dependsOn: [],
        blocks: [],
        dueAt: null,
        tasks: [],
      },
    ],
    comments: [],
    templates: [],
    webhooks: [],
  },
};

const v2Fixture = {
  version: 2,
  exportedAt: "2025-01-01T00:00:00Z",
  habitat: {
    name: "Modern Habitat",
    description: "A v2 export",
    columns: [
      {
        name: "Todo",
        order: 0,
        wipLimit: null,
        autoAdvance: false,
        requiresClaim: false,
        nextColumnName: null,
        isTerminal: false,
      },
    ],
    missions: [
      {
        title: "Modern Mission",
        description: "A modern mission",
        acceptanceCriteria: "Done",
        priority: "medium",
        labels: [],
        columnName: "Todo",
        status: "backlog",
        dependsOn: [],
        blocks: [],
        dueAt: null,
        tasks: [],
      },
    ],
    comments: [],
    templates: [],
    webhooks: [],
  },
};

function createFileWithJson(json: object): File {
  const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
  return new File([blob], "export.json", { type: "application/json" });
}

describe("ImportHabitatDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderDialog(props: { habitatId?: string } = {}) {
    return render(
      <ImportHabitatDialog open={true} onClose={vi.fn()} onImport={vi.fn()} {...props} />,
    );
  }

  async function loadFixture(fixture: object) {
    const file = createFileWithJson(fixture);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.queryByText("Choose File")).toBeNull();
    });
  }

  it("renders file chooser when no file loaded", () => {
    renderDialog();
    expect(screen.getByText("Choose File")).toBeTruthy();
  });

  it("previews v1 export with board.features normalized to missions", async () => {
    renderDialog();
    await loadFixture(v1Fixture);
    expect(screen.getByText("Legacy Board")).toBeTruthy();
    expect(screen.getByText("Missions:")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("previews v2 export with habitat.missions", async () => {
    renderDialog();
    await loadFixture(v2Fixture);
    expect(screen.getByText("Modern Habitat")).toBeTruthy();
    const missionLabel = screen.getByText("Missions:");
    const missionCount = missionLabel.parentElement?.querySelector(".font-medium");
    expect(missionCount?.textContent).toBe("1");
  });

  it("shows error for invalid JSON", async () => {
    renderDialog();
    const blob = new Blob(["not json"], { type: "application/json" });
    const file = new File([blob], "bad.json", { type: "application/json" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText(/JSON/)).toBeTruthy();
    });
  });

  it("shows error for unsupported version", async () => {
    renderDialog();
    const badVersion = { version: 3, habitat: { name: "X" } };
    await loadFixture(badVersion);
    expect(screen.getByText(/Unsupported export version/)).toBeTruthy();
  });

  it("shows merge mode option when habitatId is provided", async () => {
    renderDialog({ habitatId: "existing-h1" });
    await loadFixture(v2Fixture);
    expect(screen.getByText(/Merge:/)).toBeTruthy();
    expect(screen.getByText(/Replace:/)).toBeTruthy();
  });

  it("calls importInto when merging with habitatId", async () => {
    mockImportInto.mockResolvedValue({
      habitat: { id: "existing-h1" },
      columns: [],
      imported: { missions: 1, tasks: 0, comments: 0, templates: 0, webhooks: 0 },
      warnings: [],
    });
    const onImport = vi.fn();
    render(
      <ImportHabitatDialog
        open={true}
        onClose={vi.fn()}
        onImport={onImport}
        habitatId="existing-h1"
      />,
    );
    await loadFixture(v2Fixture);

    const mergeLabel = screen.getByText(/Merge:/).closest("label");
    const mergeRadio = mergeLabel?.querySelector("input");
    if (mergeRadio) fireEvent.click(mergeRadio);

    const importBtn = screen.getByText("Merge Import");
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(mockImportInto).toHaveBeenCalledWith(
        "existing-h1",
        expect.objectContaining({ version: 2 }),
      );
    });
  });

  it("calls import when not merging", async () => {
    mockImport.mockResolvedValue({
      habitat: { id: "new-h1" },
      columns: [],
      imported: { missions: 1, tasks: 0, comments: 0, templates: 0, webhooks: 0 },
      warnings: [],
    });
    const onImport = vi.fn();
    render(<ImportHabitatDialog open={true} onClose={vi.fn()} onImport={onImport} />);
    await loadFixture(v2Fixture);

    const importBtn = screen.getByText("Import");
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(mockImport).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));
    });
  });
});
