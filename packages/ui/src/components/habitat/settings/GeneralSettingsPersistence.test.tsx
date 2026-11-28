import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast as sonnerToast } from "sonner";
import { HabitatSettingsDialog } from "../HabitatSettingsDialog.js";
import { SessionStateProvider, useAccountSession } from "../../../lib/sessionState.js";
import type { PublicHabitat } from "../../../types/index.js";

// Keep HabitatSettingsDialog, GeneralTab, useHabitatSettingsSaver, api.habitats.update,
// transport, Dialog, Button, and sessionState real; mock unrelated tabs and sub-dialogs.
vi.mock("./NotificationsTab.js", () => ({ NotificationsTab: () => null }));
vi.mock("./ChatIntegrationsTab.js", () => ({ ChatIntegrationsTab: () => null }));
vi.mock("./RetryPolicyTab.js", () => ({ RetryPolicyTab: () => null }));
vi.mock("./AnomalyDetectionTab.js", () => ({ AnomalyDetectionTab: () => null }));
vi.mock("./AutoAssignTab.js", () => ({ AutoAssignTab: () => null }));
vi.mock("./PrioritizationTab.js", () => ({ PrioritizationTab: () => null }));
vi.mock("./AutomationTab.js", () => ({ AutomationTab: () => null }));
vi.mock("./ScheduledTasksTab.js", () => ({ ScheduledTasksTab: () => null }));
vi.mock("./ReviewRulesTab.js", () => ({ ReviewRulesTab: () => null }));
vi.mock("./IntegrationsTab.js", () => ({ IntegrationsTab: () => null }));
vi.mock("./WorktreeTab.js", () => ({ WorktreeTab: () => null }));
vi.mock("./RepositoryTab.js", () => ({ RepositoryTab: () => null }));
vi.mock("./PluginsTab.js", () => ({ PluginsTab: () => null }));
vi.mock("./LearningLoopTab.js", () => ({ LearningLoopTab: () => null }));
vi.mock("./TriageSettingsTab.js", () => ({ TriageSettingsTab: () => null }));
vi.mock("./RoadmapSettingsTab.js", () => ({ RoadmapSettingsTab: () => null }));
vi.mock("../ExportHabitatDialog.js", () => ({ ExportHabitatDialog: () => null }));
vi.mock("../ImportHabitatManifestDialog.js", () => ({ ImportHabitatManifestDialog: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function makeHabitat(overrides: Partial<PublicHabitat> = {}): PublicHabitat {
  return {
    id: "h1",
    name: "Original Habitat",
    description: "Original description",
    columns: [],
    teamId: null,
    retrySettings: null,
    anomalySettings: null,
    autoAssignSettings: null,
    prioritizationSettings: null,
    remoteGovernanceSettings: null,
    automationSettings: null,
    codeReviewSettings: null,
    ciCdSettings: null,
    gitWorktreeSettings: null,
    wikiSettings: null,
    triageSettings: null,
    releaseSettings: null,
    roadmapSettings: null,
    lifecycleSettings: null,
    eventRetentionDays: null,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    ...overrides,
  };
}

function AccountSwitchButton() {
  const session = useAccountSession();
  return (
    <button
      type="button"
      onClick={() => {
        session.logout();
        session.completeAuthentication(session.beginAuthentication(), "bob-token");
      }}
    >
      Sign in as Bob
    </button>
  );
}

interface FixtureProps {
  initial?: PublicHabitat;
  onUpdateSpy?: (habitat: PublicHabitat) => void;
  onCloseSpy?: () => void;
  closeInsideOnUpdate?: boolean;
}

function DialogFixture({
  initial = makeHabitat(),
  onUpdateSpy,
  onCloseSpy,
  closeInsideOnUpdate = false,
}: FixtureProps) {
  const [habitat, setHabitat] = useState(initial);
  const [open, setOpen] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <HabitatSettingsDialog
        habitat={habitat}
        open={open}
        onClose={() => {
          onCloseSpy?.();
          setOpen(false);
        }}
        onUpdate={(updated) => {
          onUpdateSpy?.(updated);
          setHabitat(updated);
          if (closeInsideOnUpdate) {
            setOpen(false);
          }
        }}
        onDelete={() => {}}
      />
    </>
  );
}

function renderWithProviders(ui: React.ReactElement, withSessionProvider = false) {
  if (withSessionProvider) {
    return render(
      <SessionStateProvider>
        <AccountSwitchButton />
        {ui}
      </SessionStateProvider>,
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("orcy_token", "alice-token");
});

afterEach(() => {
  sonnerToast.dismiss();
  cleanup();
  vi.restoreAllMocks();
});

describe("General Habitat settings persistence", () => {
  it("keeps dialog and draft open on failed PATCH, shows error, and closes normally on successful retry", async () => {
    const initial = makeHabitat();
    const patchBodies: Array<{ name?: string; description?: string }> = [];
    const errorToast = vi.spyOn(sonnerToast, "error");
    const successToast = vi.spyOn(sonnerToast, "success");
    const onUpdateSpy = vi.fn();
    const onCloseSpy = vi.fn();

    let attempt = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/habitats/h1" && init?.method === "PATCH") {
        attempt += 1;
        const body = JSON.parse(String(init.body)) as { name?: string; description?: string };
        patchBodies.push(body);
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: "Database write failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            habitat: {
              ...initial,
              name: body.name ?? initial.name,
              description: body.description ?? initial.description,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request ${String(input)}`);
    });

    renderWithProviders(
      <DialogFixture initial={initial} onUpdateSpy={onUpdateSpy} onCloseSpy={onCloseSpy} />,
    );

    const nameInput = screen.getByDisplayValue("Original Habitat") as HTMLInputElement;
    const descInput = screen.getByDisplayValue("Original description") as HTMLTextAreaElement;
    fireEvent.change(nameInput, { target: { value: "  Updated Habitat  " } });
    fireEvent.change(descInput, { target: { value: "  Updated description  " } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith("Database write failed", expect.any(Object));
    });
    expect(screen.getByRole("alert").textContent).toContain("Database write failed");
    expect(successToast).not.toHaveBeenCalled();
    expect(onUpdateSpy).not.toHaveBeenCalled();
    expect(onCloseSpy).not.toHaveBeenCalled();

    // Dialog and entered draft stay open and retryable
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (
        screen.getByDisplayValue("  Updated Habitat  ", {
          normalizer: (text) => text,
        }) as HTMLInputElement
      ).value,
    ).toBe("  Updated Habitat  ");
    expect(
      (
        screen.getByDisplayValue("  Updated description  ", {
          normalizer: (text) => text,
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("  Updated description  ");
    const retrySaveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(retrySaveBtn.disabled).toBe(false);

    // Retry persists intended trimmed name/description and closes normally
    fireEvent.click(retrySaveBtn);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(patchBodies).toEqual([
      { name: "Updated Habitat", description: "Updated description" },
      { name: "Updated Habitat", description: "Updated description" },
    ]);
    expect(onUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "h1",
        name: "Updated Habitat",
        description: "Updated description",
      }),
    );
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(successToast).toHaveBeenCalledWith("Habitat settings saved", expect.any(Object));

    // Reopening shows the persisted values and no stale error alert
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByDisplayValue("Updated Habitat")).toBeTruthy();
    expect(screen.getByDisplayValue("Updated description")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["cancel", "escape"] as const)(
    "closes cleanly on intentional %s after a failed PATCH and restores original values on reopen",
    async (dismissKind) => {
      const initial = makeHabitat();
      const errorToast = vi.spyOn(sonnerToast, "error");
      const onUpdateSpy = vi.fn();
      const onCloseSpy = vi.fn();

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "Save rejected" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

      renderWithProviders(
        <DialogFixture initial={initial} onUpdateSpy={onUpdateSpy} onCloseSpy={onCloseSpy} />,
      );

      fireEvent.change(screen.getByDisplayValue("Original Habitat"), {
        target: { value: "Unsaved Draft" },
      });
      fireEvent.change(screen.getByDisplayValue("Original description"), {
        target: { value: "Unsaved description" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith("Save rejected", expect.any(Object)),
      );

      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByDisplayValue("Unsaved Draft")).toBeTruthy();

      if (dismissKind === "cancel") {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      } else {
        fireEvent.keyDown(document, { key: "Escape" });
      }

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onCloseSpy).toHaveBeenCalledTimes(1);
      expect(onUpdateSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
      expect(screen.getByDisplayValue("Original Habitat")).toBeTruthy();
      expect(screen.getByDisplayValue("Original description")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each([
    { retire: true, fail: false },
    { retire: true, fail: true },
    { retire: false, fail: false },
    { retire: false, fail: true },
  ])(
    "preserves session liveness for General save (retire=$retire, fail=$fail)",
    async ({ retire, fail }) => {
      const patch = deferred<Response>();
      const errorToast = vi.spyOn(sonnerToast, "error");
      const successToast = vi.spyOn(sonnerToast, "success");
      const onUpdateSpy = vi.fn();
      const onCloseSpy = vi.fn();
      const authHeaders: string[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (String(input) === "/api/habitats/h1" && init?.method === "PATCH") {
          authHeaders.push(new Headers(init.headers).get("Authorization") ?? "");
          return patch.promise;
        }
        throw new Error(`Unexpected request ${String(input)}`);
      });

      renderWithProviders(
        <DialogFixture
          initial={makeHabitat()}
          onUpdateSpy={onUpdateSpy}
          onCloseSpy={onCloseSpy}
          closeInsideOnUpdate
        />,
        true,
      );

      fireEvent.change(screen.getByDisplayValue("Original Habitat"), {
        target: { value: "Alice Renamed" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(authHeaders).toEqual(["Bearer alice-token"]));

      if (retire) {
        fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
      }

      await act(async () => {
        patch.resolve(
          fail
            ? new Response(JSON.stringify({ error: "Alice private save refusal" }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
              })
            : new Response(
                JSON.stringify({
                  habitat: makeHabitat({ name: "Alice Renamed" }),
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              ),
        );
      });

      expect(successToast).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
      expect(errorToast).toHaveBeenCalledTimes(!retire && fail ? 1 : 0);
      expect(onUpdateSpy).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
      expect(onCloseSpy).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
      if (!retire && fail) {
        expect(errorToast).toHaveBeenCalledWith(
          "Alice private save refusal",
          expect.any(Object),
        );
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.getByDisplayValue("Alice Renamed")).toBeTruthy();
      }
    },
  );
});
