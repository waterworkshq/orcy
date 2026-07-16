import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SideNavBar } from "./SideNavBar.js";
import { APP_VERSION } from "../../version.js";

function renderWithRouter(ui: React.ReactElement, initialEntries = ["/"]) {
  return render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}

describe("SideNavBar", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders with glass-panel class", () => {
    const { container } = renderWithRouter(<SideNavBar />);
    const nav = container.querySelector('[data-testid="side-nav-bar"]');
    expect(nav).toBeTruthy();
    expect(nav!.className).toContain("glass-panel");
  });

  it("renders ghost-border-r for container edge", () => {
    const { container } = renderWithRouter(<SideNavBar />);
    const nav = container.querySelector('[data-testid="side-nav-bar"]');
    expect(nav!.className).toContain("ghost-border-r");
  });

  it("renders all route navigation items", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.getByTestId("nav-item-pod-base")).toBeTruthy();
    expect(screen.getByTestId("nav-item-echo-base")).toBeTruthy();
    expect(screen.getByTestId("nav-item-orcy-pod")).toBeTruthy();
    expect(screen.getByTestId("nav-item-wake")).toBeTruthy();
  });

  it("Agents nav item links to /agents", () => {
    renderWithRouter(<SideNavBar />);
    const agentsLink = screen.getByTestId("nav-item-orcy-pod");
    expect(agentsLink.getAttribute("href")).toBe("/agents");
  });

  it("Wake nav item links to current habitat activity route", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1"]);
    const activityLink = screen.getByTestId("nav-item-wake");
    expect(activityLink.getAttribute("href")).toBe("/habitats/hab-1/activity");
  });

  it("Wake nav item is disabled when no current habitat", () => {
    renderWithRouter(<SideNavBar />);
    const activityItem = screen.getByTestId("nav-item-wake");
    expect(activityItem.tagName).not.toBe("A");
    expect(activityItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not render Teams nav item", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.queryByTestId("nav-item-teams")).toBeNull();
  });

  it("renders drawer tool items (Stats and Dependencies only)", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.getByTestId("tool-item-stats")).toBeTruthy();
    expect(screen.getByTestId("tool-item-dependencies")).toBeTruthy();
  });

  it("does not render Activity in tool items", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.queryByTestId("tool-item-activity")).toBeNull();
  });

  it("does not render Agents in tool items", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.queryByTestId("tool-item-agents")).toBeNull();
  });

  it("calls drawer callbacks when tool items are clicked", () => {
    const onOpenStats = vi.fn();
    const onOpenDependencies = vi.fn();

    renderWithRouter(
      <SideNavBar onOpenStats={onOpenStats} onOpenDependencies={onOpenDependencies} />,
    );

    fireEvent.click(screen.getByTestId("tool-item-stats"));
    fireEvent.click(screen.getByTestId("tool-item-dependencies"));

    expect(onOpenStats).toHaveBeenCalledOnce();
    expect(onOpenDependencies).toHaveBeenCalledOnce();
  });

  it("renders Deploy New Agent button", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.getByTestId("deploy-agent-btn")).toBeTruthy();
    expect(screen.getByText("Deploy New Agent")).toBeTruthy();
  });

  it("calls onDeployAgent when deploy button clicked", () => {
    const onDeploy = vi.fn();
    renderWithRouter(<SideNavBar onDeployAgent={onDeploy} />);
    fireEvent.click(screen.getByTestId("deploy-agent-btn"));
    expect(onDeploy).toHaveBeenCalledOnce();
  });

  it("renders POD BASE branding with version", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.getByText("POD BASE")).toBeTruthy();
    expect(screen.getByText(`v${APP_VERSION}`)).toBeTruthy();
  });

  it("renders VIEWS and TOOLS section labels", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.getByText("VIEWS")).toBeTruthy();
    expect(screen.getByText("TOOLS")).toBeTruthy();
  });

  it("renders Support footer link", () => {
    renderWithRouter(<SideNavBar />);
    const support = screen.getByText("Support").closest("a");
    expect(support).toBeTruthy();
    expect(support?.getAttribute("href")).not.toBe("#");
  });

  it("does not render Status footer link", () => {
    renderWithRouter(<SideNavBar />);
    expect(screen.queryByText("Status")).toBeNull();
  });

  it("navigation items are clickable links", () => {
    renderWithRouter(<SideNavBar />);
    const workspaceLink = screen.getByTestId("nav-item-echo-base");
    expect(workspaceLink.tagName).toBe("A");
    expect(workspaceLink.getAttribute("href")).toBe("/");
  });

  it("highlights active Echo Base nav item on habitat detail routes", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/board-1"]);
    const activeItem = screen.getByTestId("nav-item-echo-base");
    expect(activeItem.className).toContain("bg-primary-container");
    expect(activeItem.className).toContain("font-medium");
  });

  it("highlights active Echo Base nav item on habitat wiki routes", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/board-1/wiki"]);
    const activeItem = screen.getByTestId("nav-item-echo-base");
    expect(activeItem.className).toContain("bg-primary-container");
  });

  it("highlights active Echo Base nav item on /missions/:id route", () => {
    renderWithRouter(<SideNavBar />, ["/missions/mission-1"]);
    const activeItem = screen.getByTestId("nav-item-echo-base");
    expect(activeItem.className).toContain("bg-primary-container");
    expect(activeItem.className).toContain("font-medium");
  });

  it("does not highlight Echo Base on /dashboard route", () => {
    renderWithRouter(<SideNavBar />, ["/dashboard"]);
    const activeItem = screen.getByTestId("nav-item-echo-base");
    expect(activeItem.className).not.toContain("bg-primary-container");
  });

  it("highlights active Orcy Pod nav item on /agents route", () => {
    renderWithRouter(<SideNavBar />, ["/agents"]);
    const activeItem = screen.getByTestId("nav-item-orcy-pod");
    expect(activeItem.className).toContain("bg-primary-container");
    expect(activeItem.className).toContain("font-medium");
  });

  it("highlights active Wake nav item on habitat activity route", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/activity"]);
    const activeItem = screen.getByTestId("nav-item-wake");
    expect(activeItem.className).toContain("bg-primary-container");
    expect(activeItem.className).toContain("font-medium");
  });

  it("activates ONLY Wake on habitat activity route (no Echo Base double-active)", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/activity"]);
    const activeLabels = ["nav-item-echo-base", "nav-item-wake", "nav-item-remote-pods"]
      .filter((id) => screen.getByTestId(id).className.includes("bg-primary-container"));
    expect(activeLabels).toEqual(["nav-item-wake"]);
  });

  it("activates ONLY Remote Pods on habitat remote-pods route (no Echo Base double-active)", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/remote-pods"]);
    const activeLabels = ["nav-item-echo-base", "nav-item-wake", "nav-item-remote-pods"]
      .filter((id) => screen.getByTestId(id).className.includes("bg-primary-container"));
    expect(activeLabels).toEqual(["nav-item-remote-pods"]);
  });

  it("activates ONLY Workflow Metrics on habitat admin workflows route", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/admin/workflows"]);
    const adminLink = screen.getByTestId("nav-item-workflow-metrics");
    expect(adminLink.className).toContain("bg-primary-container");
    const activeRouteLabels = [
      "nav-item-echo-base",
      "nav-item-wake",
      "nav-item-remote-pods",
    ].filter((id) => screen.getByTestId(id).className.includes("bg-primary-container"));
    expect(activeRouteLabels).toEqual([]);
  });

  it("does not activate Wake or Remote Pods on near-prefix paths", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/activity-archive"]);
    const wake = screen.getByTestId("nav-item-wake");
    const remote = screen.getByTestId("nav-item-remote-pods");
    expect(wake.className).not.toContain("bg-primary-container");
    expect(remote.className).not.toContain("bg-primary-container");
  });

  it("does not activate Pod Base on near-prefix paths like /dashboard-archive", () => {
    renderWithRouter(<SideNavBar />, ["/dashboard-archive"]);
    const podBase = screen.getByTestId("nav-item-pod-base");
    expect(podBase.className).not.toContain("bg-primary-container");
  });

  it("does not activate Orcy Pod on near-prefix paths like /agents-old", () => {
    renderWithRouter(<SideNavBar />, ["/agents-old"]);
    const orcyPod = screen.getByTestId("nav-item-orcy-pod");
    expect(orcyPod.className).not.toContain("bg-primary-container");
  });

  it("does not activate Workflow Metrics on near-prefix paths", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/admin/workflows-archive"]);
    const adminLink = screen.getByTestId("nav-item-workflow-metrics");
    expect(adminLink.className).not.toContain("bg-primary-container");
  });

  it("activates Echo Base on /habitats/:id/wiki and not on /habitats/:id/wiki-archive", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1/wiki-archive"]);
    const echo = screen.getByTestId("nav-item-echo-base");
    expect(echo.className).not.toContain("bg-primary-container");
  });

  it("Remote Pods links to habitat-scoped route when habitat is in context", () => {
    renderWithRouter(<SideNavBar />, ["/habitats/hab-1"]);
    const remotePodsLink = screen.getByTestId("nav-item-remote-pods");
    expect(remotePodsLink.tagName).toBe("A");
    expect(remotePodsLink.getAttribute("href")).toBe("/habitats/hab-1/remote-pods");
  });

  it("Remote Pods is disabled when no current habitat", () => {
    renderWithRouter(<SideNavBar />);
    const remotePodsItem = screen.getByTestId("nav-item-remote-pods");
    expect(remotePodsItem.tagName).not.toBe("A");
    expect(remotePodsItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("Remote Pods disabled title describes the feature (not the Wake activity title)", () => {
    renderWithRouter(<SideNavBar />);
    const remotePodsItem = screen.getByTestId("nav-item-remote-pods");
    expect(remotePodsItem.getAttribute("title")).toBe(
      "Open a habitat to view its remote pods",
    );
  });

  it("Wake disabled title still describes the activity feature", () => {
    renderWithRouter(<SideNavBar />);
    const wakeItem = screen.getByTestId("nav-item-wake");
    expect(wakeItem.getAttribute("title")).toBe(
      "Open a habitat to view its activity",
    );
  });

  it("inactive items do not have active styling", () => {
    renderWithRouter(<SideNavBar />);
    const inactiveItem = screen.getByTestId("nav-item-orcy-pod");
    expect(inactiveItem.className).not.toContain("bg-primary-container");
    expect(inactiveItem.className).toContain("text-on-surface-variant");
  });

  describe("React.memo wrapping", () => {
    it("SideNavBar is wrapped in React.memo", () => {
      expect((SideNavBar as any).$$typeof).toBe(Symbol.for("react.memo"));
      expect(typeof (SideNavBar as any).type).toBe("function");
    });
  });
});
