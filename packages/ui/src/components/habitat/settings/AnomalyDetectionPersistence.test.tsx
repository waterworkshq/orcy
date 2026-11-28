import React, { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnomalyDetectionTab, type AnomalyDetectionTabHandle } from "./AnomalyDetectionTab.js";
import { HabitatSettingsDialog } from "../HabitatSettingsDialog.js";
import type { AnomalySettings, PublicHabitat } from "../../../types/index.js";
import { notify } from "../../../lib/toast.js";

// Other tabs are outside this workflow; keep the mounted anomaly tab and saver real.
vi.mock("./GeneralTab.js", () => ({ GeneralTab: () => null }));
vi.mock("./NotificationsTab.js", () => ({ NotificationsTab: () => null }));
vi.mock("./ChatIntegrationsTab.js", () => ({ ChatIntegrationsTab: () => null }));
vi.mock("./RetryPolicyTab.js", () => ({ RetryPolicyTab: () => null }));
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
vi.mock("../../../lib/toast.js", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const settings: AnomalySettings = {
  enabled: true, scanIntervalMinutes: 9,
  thresholds: { staleInProgressMinutes: 121, rejectionRatePercent: 30, rejectionWindowTasks: 8, cycleTimeIncreasePercent: 65, backlogToAgentRatio: 3, agentOfflineMinutes: 25 },
  notifications: { email: false, sse: true, chat: false },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("Anomaly Detection settings", () => {
  it("disables without sending invalid hidden drafts", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ habitat: { id: "h1" } }), { status: 200 }));
    const ref = createRef<AnomalyDetectionTabHandle>();
    render(<AnomalyDetectionTab ref={ref} habitatId="h1" boardAnomalySettings={settings} onUpdate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Scan Interval (min)"), { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await act(async () => { await ref.current!.save(); });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body))).toEqual({ anomalySettings: { enabled: false } });
  });
  it("saves through the mounted Habitat dialog and reopens off", async () => {
    const initial = { id: "h1", name: "Fixture", description: "", anomalySettings: settings } as PublicHabitat;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ habitat: { ...initial, anomalySettings: { ...settings, ...JSON.parse(String(init.body)).anomalySettings } } }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    function Fixture() {
      const [habitat, setHabitat] = useState(initial);
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen(true)}>Reopen</button><HabitatSettingsDialog habitat={habitat} open={open} onClose={() => setOpen(false)} onUpdate={(updated) => { setHabitat(updated); setOpen(false); }} onDelete={() => {}} /></>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);
    fireEvent.click(screen.getByText("Anomaly Detection"));
    fireEvent.click(screen.getAllByRole("switch")[0]);
    fireEvent.click(screen.getByText("Save Anomaly Settings"));
    await waitFor(() => expect(screen.queryByText("Save Anomaly Settings")).toBeNull());
    fireEvent.click(screen.getByText("Reopen"));
    fireEvent.click(screen.getByText("Anomaly Detection"));
    expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("false");
  });

  it("saves an explicit disable with the existing settings and shows it off on reopen", async () => {
    let stored: AnomalySettings | null = settings;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stored = { ...settings, ...JSON.parse(String(init?.body)).anomalySettings };
      return new Response(JSON.stringify({ habitat: { id: "h1", anomalySettings: stored } }), { status: 200 });
    });
    const ref = createRef<AnomalyDetectionTabHandle>();
    const onUpdate = vi.fn();
    const view = render(<AnomalyDetectionTab ref={ref} habitatId="h1" boardAnomalySettings={stored} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await act(async () => { await ref.current!.save(); });
    expect(fetcher).toHaveBeenCalledWith("/api/habitats/h1", expect.objectContaining({ method: "PATCH" }));
    expect(stored).toEqual({ ...settings, enabled: false });
    expect(onUpdate).toHaveBeenCalled();
    view.unmount();
    render(<AnomalyDetectionTab habitatId="h1" boardAnomalySettings={stored} onUpdate={onUpdate} />);
    expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("false");
  });

  it("reports a failed save without reporting success or updating the habitat", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Save failed" }), { status: 500 }));
    const ref = createRef<AnomalyDetectionTabHandle>();
    const onUpdate = vi.fn<(habitat: PublicHabitat) => void>();
    render(<AnomalyDetectionTab ref={ref} habitatId="h1" boardAnomalySettings={settings} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await act(async () => { await ref.current!.save(); });
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith("Save failed"));
    expect(notify.success).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("saves an ordinary enable after starting with inherited defaults", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ habitat: { id: "h1" } }), { status: 200 }));
    const ref = createRef<AnomalyDetectionTabHandle>();
    render(<AnomalyDetectionTab ref={ref} habitatId="h1" boardAnomalySettings={null} onUpdate={vi.fn()} />);
    expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("true");
    await act(async () => { await ref.current!.save(); });
    const request = fetcher.mock.calls[0][1]!;
    expect(JSON.parse(String(request.body)).anomalySettings).toMatchObject({ enabled: true, scanIntervalMinutes: 5 });
  });
});
