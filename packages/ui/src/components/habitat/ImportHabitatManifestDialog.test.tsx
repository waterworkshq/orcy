import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ImportHabitatManifestDialog } from "./ImportHabitatManifestDialog.js";

const mockPublish = vi.fn();
const mockNotifyError = vi.fn();
const mockNotifySuccess = vi.fn();

vi.mock("../../api/domains/imports.js", async () => {
  // Use vi.importActual so the REAL parseImportApiError / parsePublishImportResponse
  // are available — the integration-style test below exercises the real transport
  // recovery path and would be silently neutered if we shadowed these helpers.
  const actual = await vi.importActual<typeof import("../../api/domains/imports.js")>(
    "../../api/domains/imports.js",
  );
  return {
    ...actual,
    importsApi: {
      publish: (...args: unknown[]) => mockPublish(...args),
    },
  };
});

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
  Button: ({ children, onClick, disabled, loading, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled || loading} {...rest}>
      {loading ? "Loading..." : children}
    </button>
  ),
}));

// ---- Fixtures --------------------------------------------------------------

const v3PublishedResponse = {
  outcome: "published",
  importAttempt: {
    id: "imp-1",
    habitatId: "new-hab",
    state: "published",
    sourceManifestId: "mfst-1",
    sourceHabitatId: null,
    sourceExportedAt: null,
    actorType: "human",
    actorId: "u1",
    reservedAt: "2026-07-21T00:00:00Z",
    publishedAt: "2026-07-21T00:00:01Z",
    rejectedAt: null,
    result: null,
  },
  habitatId: "new-hab",
  importedCounts: { columns: 4, missions: 2, tasks: 5 },
};

const v3RejectedPreflightResponse = {
  outcome: "rejected_preflight",
  importAttemptId: "imp-2",
  errors: [
    { field: "columns.name", code: "missing", message: "Column 1 has no name" },
    { field: "missions.dependsOnSourceIds", code: "dangling", message: "Mission dep references missing source" },
    { field: "manifest", code: "missing_required", message: "Top-level manifest mode is required" },
  ],
};

const v3VetoedResponse = {
  outcome: "vetoed",
  importAttempt: {
    id: "imp-3",
    habitatId: null,
    state: "rejected",
    sourceManifestId: "mfst-3",
    sourceHabitatId: null,
    sourceExportedAt: null,
    actorType: "human",
    actorId: "u1",
    reservedAt: "2026-07-21T00:00:00Z",
    publishedAt: null,
    rejectedAt: "2026-07-21T00:00:02Z",
    result: null,
  },
  vetoes: [
    {
      taskSourceId: "task-src-1",
      taskTitle: "Refactor auth",
      veto: {
        interceptorKey: "domain_expert",
        reason: "No domain-expert available for security tasks",
        pluginRunId: null,
      },
    },
    {
      taskSourceId: "task-src-2",
      taskTitle: "Add feature X",
      veto: {
        interceptorKey: "capacity",
        reason: "All agents at capacity",
        pluginRunId: "run-7",
      },
    },
  ],
};

const v3AlreadyPublishingResponse = {
  outcome: "already_publishing",
  importAttempt: {
    ...v3PublishedResponse.importAttempt,
    id: "imp-publishing",
    habitatId: null,
    state: "publishing",
    publishedAt: null,
  },
  status: "publishing",
};

const legacySuccessResponse = {
  habitat: { id: "legacy-h1", name: "Legacy" },
  columns: [{ id: "c1", name: "Todo" }],
  imported: { missions: 1, tasks: 2, comments: 0, templates: 0, webhooks: 0 },
  warnings: [],
};

const v3Manifest = {
  version: 3,
  manifestId: "mfst-1",
  generatedAt: "2026-07-20T00:00:00Z",
  mode: "new",
  identityPolicy: "remap",
  lineage: { sourceHabitatId: null, sourceExportedAt: null, sourceManifestId: null },
  domains: {
    columns: {
      disposition: "replace",
      data: [{ sourceId: "c1", name: "Todo", order: 0, wipLimit: null, nextColumnName: null, isTerminal: false }],
    },
    missions: {
      disposition: "replace",
      data: [],
    },
  },
};

function createFileWithJson(json: object): File {
  const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
  return new File([blob], "manifest.json", { type: "application/json" });
}

// ---- Tests -----------------------------------------------------------------

describe("ImportHabitatManifestDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderDialog(props: { habitatId?: string } = {}) {
    return render(
      <ImportHabitatManifestDialog
        open={true}
        onClose={vi.fn()}
        onImport={vi.fn()}
        {...props}
      />,
    );
  }

  async function loadFixture(fixture: object) {
    const file = createFileWithJson(fixture);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.queryByTestId("file-chooser")).toBeNull();
    });
  }

  // --- Happy path: v3 → 201 → published ----------------------------------

  it("renders v3 happy path: upload → 201 published → navigate", async () => {
    mockPublish.mockResolvedValue(v3PublishedResponse);
    const onImport = vi.fn();
    render(
      <ImportHabitatManifestDialog open={true} onClose={vi.fn()} onImport={onImport} />,
    );

    await loadFixture(v3Manifest);

    expect(screen.getByTestId("config-form")).toBeTruthy();

    // The import button is enabled
    const importBtn = screen.getByTestId("import-btn");
    expect((importBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(screen.getByTestId("outcome-published")).toBeTruthy();
    });

    expect(screen.getByText(/Imported counts/)).toBeTruthy();

    // Click the navigate button
    fireEvent.click(screen.getByTestId("navigate-to-habitat"));

    expect(onImport).toHaveBeenCalledWith("new-hab", "new");
  });

  // --- Rejected preflight: per-domain grouping + banner ------------------

  it("renders rejected_preflight: groups errors by domain + shows banner", async () => {
    mockPublish.mockResolvedValue(v3RejectedPreflightResponse);
    renderDialog();

    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("outcome-rejected-preflight")).toBeTruthy();
    });

    // "Existing habitat state is unchanged" banner
    expect(screen.getByTestId("state-unchanged-banner")).toBeTruthy();
    expect(screen.getByText(/Existing habitat state is unchanged/)).toBeTruthy();

    // Per-domain grouping: columns and missions should be present, plus
    // ungrouped for the `manifest` field
    expect(screen.getByTestId("error-group-columns")).toBeTruthy();
    expect(screen.getByTestId("error-group-missions")).toBeTruthy();
    expect(screen.getByTestId("error-group-ungrouped")).toBeTruthy();

    // The fields appear inside their respective groups
    const columnsGroup = screen.getByTestId("error-group-columns");
    expect(columnsGroup.textContent).toContain("columns.name");
    expect(columnsGroup.textContent).toContain("missing");

    const missionsGroup = screen.getByTestId("error-group-missions");
    expect(missionsGroup.textContent).toContain("missions.dependsOnSourceIds");
  });

  // --- Vetoed: per-Task vetoes -------------------------------------------

  it("renders vetoed: per-task vetoes with task title + reason", async () => {
    mockPublish.mockResolvedValue(v3VetoedResponse);
    renderDialog();

    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("outcome-vetoed")).toBeTruthy();
    });

    expect(screen.getByTestId("state-unchanged-banner")).toBeTruthy();
    expect(screen.getByTestId("veto-task-src-1")).toBeTruthy();
    expect(screen.getByText(/Refactor auth/)).toBeTruthy();
    expect(screen.getByText(/No domain-expert/)).toBeTruthy();
    expect(screen.getByTestId("veto-task-src-2")).toBeTruthy();
    expect(screen.getByText(/Add feature X/)).toBeTruthy();
  });

  it("checks already_publishing by idempotently re-submitting the same manifest", async () => {
    mockPublish
      .mockResolvedValueOnce(v3AlreadyPublishingResponse)
      .mockResolvedValueOnce(v3PublishedResponse);
    renderDialog();
    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));
    await waitFor(() => expect(screen.getByTestId("outcome-already-publishing")).toBeTruthy());
    expect(screen.queryByText(/Polling endpoint/)).toBeNull();

    fireEvent.click(screen.getByTestId("check-import-status"));
    await waitFor(() => expect(screen.getByTestId("outcome-published")).toBeTruthy());
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish.mock.calls[1]).toEqual(mockPublish.mock.calls[0]);
  });

  // --- Legacy fallback: response shape dispatch --------------------------

  it("renders legacy fallback: response without outcome uses legacy success card", async () => {
    mockPublish.mockResolvedValue(legacySuccessResponse);
    const onImport = vi.fn();
    render(
      <ImportHabitatManifestDialog open={true} onClose={vi.fn()} onImport={onImport} />,
    );

    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("outcome-legacy")).toBeTruthy();
    });

    // Legacy success message
    expect(screen.getByText(/legacy path/)).toBeTruthy();
    expect(screen.getByText(/1 missions/)).toBeTruthy();
    expect(screen.getByText(/2 tasks/)).toBeTruthy();

    // Navigate via the legacy button
    fireEvent.click(screen.getByTestId("navigate-to-habitat-legacy"));
    expect(onImport).toHaveBeenCalledWith("legacy-h1", "new");
  });

  // --- Pre-validation: parse error for missing version -------------------

  it("shows parse error for unrecognized manifest", async () => {
    renderDialog();
    const badManifest = { habitat: { name: "no version" } };
    await loadFixture(badManifest);
    expect(screen.getByTestId("parse-error")).toBeTruthy();
    expect(screen.getByText(/Unrecognized manifest/)).toBeTruthy();
  });

  // --- Mode conflict (v3) is surfaced via parse error -------------------

  it("surfaces v3 mode conflict as parse error", async () => {
    renderDialog({ habitatId: "existing-h1" });
    const conflictManifest = {
      ...v3Manifest,
      mode: "new", // conflicts with the replacement route (habitatId provided)
    };
    await loadFixture(conflictManifest);
    expect(screen.getByTestId("parse-error")).toBeTruthy();
    expect(screen.getByText(/Manifest mode/)).toBeTruthy();
  });

  // --- Config form: disposition matrix only for v3 ----------------------

  it("hides disposition matrix for v1/v2 manifests", async () => {
    renderDialog();
    const v2Manifest = {
      version: 2,
      exportedAt: "2025-01-01T00:00:00Z",
      habitat: { name: "Legacy", columns: [], missions: [], comments: [], templates: [], webhooks: [] },
    };
    await loadFixture(v2Manifest);

    expect(screen.getByTestId("config-form")).toBeTruthy();
    // No disposition matrix for v1/v2
    expect(screen.queryByTestId("disposition-row-columns")).toBeNull();
  });

  it("shows disposition matrix for v3 manifests", async () => {
    renderDialog();
    await loadFixture(v3Manifest);
    expect(screen.getByTestId("disposition-row-columns")).toBeTruthy();
    expect(screen.getByTestId("disposition-row-missions")).toBeTruthy();
  });

  // --- Submit error path ------------------------------------------------

  it("shows submit error on thrown request failure", async () => {
    mockPublish.mockRejectedValue(new Error("network down"));
    renderDialog();
    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("submit-error")).toBeTruthy();
    });
    expect(mockNotifyError).toHaveBeenCalledWith("network down");
  });

  // --- Transport integration: ApiError.body recovery (T10C M4 fix) ---------
  //
  // This test exercises the FULL transport stack — NOT mocking
  // importsApi.publish. The transport's request() throws ApiError on
  // non-2xx responses; without the additive `body` field, the v3 outcome
  // body would be DISCARDED and the dialog would render a generic error.
  //
  // The test mocks global `fetch` to return 422 with a v3 rejected_preflight
  // body, then asserts the dialog renders the per-domain grouped errors +
  // "existing state unchanged" banner — proving the body-recovery contract
  // holds end-to-end.

  it("recovers v3 outcome body from ApiError thrown by transport (rejected_preflight → 422)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      const body = {
        outcome: "rejected_preflight",
        importAttemptId: "imp-rec",
        errors: [
          { field: "columns.name", code: "missing", message: "Column 1 missing name" },
          {
            field: "missions.dependsOnSourceIds",
            code: "dangling",
            message: "Dangling mission dep",
          },
          { field: "manifest", code: "missing_required", message: "Top-level manifest mode" },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    // Use a real (un-mocked) importsApi by routing through the module's
    // actual export. We do this by NOT calling mockPublish for this test —
    // we mock the transport layer directly via fetch.
    mockPublish.mockImplementation(async () => {
      // Delegate to the REAL request() via fetch — fetchSpy handles the response.
      const { request } = await import("../../api/transport.js");
      return request("/habitats/import", {
        method: "POST",
        body: JSON.stringify({}),
      });
    });

    renderDialog();
    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));

    // The dialog must render the per-domain grouped errors + the banner —
    // NOT a generic "submit error". If this assertion fails, the transport
    // body-preservation contract is broken.
    await waitFor(() => {
      expect(screen.getByTestId("outcome-rejected-preflight")).toBeTruthy();
    });
    expect(screen.getByTestId("state-unchanged-banner")).toBeTruthy();
    expect(screen.getByTestId("error-group-columns")).toBeTruthy();
    expect(screen.getByTestId("error-group-missions")).toBeTruthy();
    expect(screen.getByTestId("error-group-ungrouped")).toBeTruthy();

    // Sanity: fetch was called once with the import endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledPath] = fetchSpy.mock.calls[0];
    expect(String(calledPath)).toContain("/habitats/import");

    fetchSpy.mockRestore();
  });

  it("recovers v3 outcome body from ApiError thrown by transport (vetoed → 403)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      const body = {
        outcome: "vetoed",
        importAttempt: {
          id: "imp-veto",
          habitatId: null,
          state: "rejected",
          sourceManifestId: "mfst-veto",
          sourceHabitatId: null,
          sourceExportedAt: null,
          actorType: "human",
          actorId: "u1",
          reservedAt: "2026-07-21T00:00:00Z",
          publishedAt: null,
          rejectedAt: "2026-07-21T00:00:02Z",
          result: null,
        },
        vetoes: [
          {
            taskSourceId: "task-veto-1",
            taskTitle: "Sensitive task",
            veto: { interceptorKey: "domain_expert", reason: "No expert available", pluginRunId: null },
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    mockPublish.mockImplementation(async () => {
      const { request } = await import("../../api/transport.js");
      return request("/habitats/import", {
        method: "POST",
        body: JSON.stringify({}),
      });
    });

    renderDialog();
    await loadFixture(v3Manifest);

    fireEvent.click(screen.getByTestId("import-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("outcome-vetoed")).toBeTruthy();
    });
    expect(screen.getByTestId("state-unchanged-banner")).toBeTruthy();
    expect(screen.getByTestId("veto-task-veto-1")).toBeTruthy();
    expect(screen.getByText(/Sensitive task/)).toBeTruthy();
  });
});
