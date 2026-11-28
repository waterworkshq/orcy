import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { notify } from "../../lib/toast.js";
import { HabitatSettingsDialog } from "./HabitatSettingsDialog.js";
import type { PublicHabitat } from "../../types/index.js";

// The UI uses its real client; only the network is bridged to an in-process API.
// API source modules and SQL.js provide disposable persistence without a deployed service.
const apiRoot = `${process.cwd()}/../api/src/`;
const loadApi = (path: string): Promise<any> => import(/* @vite-ignore */ `${apiRoot}${path}.ts`);
let app: any;
let db: any;
let habitat: PublicHabitat;
let receipts: Blob[];
let requests: string[];

beforeEach(async () => {
  db = await loadApi("db/index");
  await db.initTestDb();
  const [fastify, zod, routes, jwt, auth, habitats, columns, missions, tasks, webhooks, comments, templates] = await Promise.all([
    import("../../../../api/node_modules/fastify/fastify.js"),
    import("../../../../api/node_modules/fastify-type-provider-zod/dist/esm/index.js"),
    loadApi("routes/board-export"),
    import(/* @vite-ignore */ `${process.cwd()}/../api/node_modules/jsonwebtoken/index.js`),
    loadApi("middleware/jwt-verification"),
    loadApi("repositories/habitat"), loadApi("repositories/column"),
    loadApi("repositories/mission"), loadApi("repositories/task"), loadApi("services/webhooks/webhook-subscriptions"), loadApi("repositories/comment"), loadApi("repositories/template"),
  ]);
  const secret = "dev-secret-change-in-production";
  auth.setJwtSecret(secret);
  app = fastify.default({ logger: false });
  app.setValidatorCompiler(zod.validatorCompiler);
  app.setSerializerCompiler(zod.serializerCompiler);
  await app.register(routes.habitatExportRoutes, { prefix: "/api" });
  await app.ready();
  habitat = habitats.createHabitat({ name: "Synthetic habitat" });
  const column = columns.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
  const mission = missions.createMission({ habitatId: habitat.id, columnId: column.id, title: "Synthetic mission", createdBy: "user-1" });
  const task = tasks.createTask({ missionId: mission.id, title: "Synthetic task", createdBy: "user-1" });
  comments.createComment({ taskId: task.id, authorType: "human", authorId: "user-1", content: "Synthetic comment" });
  templates.createTemplate({ habitatId: habitat.id, name: "Synthetic template", titlePattern: "Example", createdBy: "user-1" });
  webhooks.createWebhookSubscription(habitat.id, "Synthetic webhook", "https://user:password@example.test/hook", "standard", ["task.created"], { Authorization: "Bearer synthetic-secret", "X-Label": "public" });
  localStorage.setItem("orcy_token", jwt.default.sign({ sub: "user-1", username: "user-1", role: "admin" }, secret, { issuer: "orcy" }));
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    requests.push(url);
    const response = await app.inject({ method: "GET", url, headers: options.headers });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
  }));
  receipts = [];
  class ReceiptURL extends URL {
    static createObjectURL(blob: Blob) { receipts.push(blob); return "blob:receipt"; }
    static revokeObjectURL() {}
  }
  vi.stubGlobal("URL", ReceiptURL);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  await app?.close();
  db?.closeDb();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openExport() {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  render(<QueryClientProvider client={client}><HabitatSettingsDialog habitat={habitat} open onClose={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
}

async function download() {
  fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  await waitFor(() => expect(receipts).toHaveLength(1));
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(receipts[0]);
  });
  return JSON.parse(text).habitat;
}

describe("Habitat Settings export", () => {
  it("warns when missions are selected without columns and preserves the selection", async () => {
    openExport();
    const missions = screen.getByRole("checkbox", { name: "Missions (with tasks and status)" });
    const columns = screen.getByRole("checkbox", { name: /Columns/ });
    const warning = "This partial export may omit columns required for import.";
    expect(screen.queryByText(warning)).toBeNull();
    fireEvent.click(columns);
    expect(screen.getByText(warning)).toBeTruthy();
    fireEvent.click(missions);
    expect(screen.queryByText(warning)).toBeNull();
    fireEvent.click(missions);
    const snapshot = await download();
    expect(snapshot.columns).toEqual([]);
    expect(snapshot.missions).toMatchObject([{ title: "Synthetic mission" }]);
    const query = new URLSearchParams(requests.find((url) => url.includes("/export"))!.split("?")[1]);
    expect(query.get("include")?.split(",")).toEqual(["missions", "comments", "templates", "webhooks"]);
  });

  it("downloads the checked mission and its task", async () => {
    openExport();
    const snapshot = await download();
    expect(snapshot.missions).toMatchObject([{ title: "Synthetic mission", tasks: [{ title: "Synthetic task" }] }]);
    expect(snapshot.webhooks).toMatchObject([{ name: "Synthetic webhook", url: "https://***@example.test/hook", headers: { Authorization: "[REDACTED]", "X-Label": "public" } }]);
    expect(JSON.stringify(snapshot.webhooks)).not.toContain("synthetic-secret");
  });

  it("prevents an all-off selection from requesting server defaults", () => {
    openExport();
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(screen.getByText("Select at least one section to export.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download JSON" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(requests.filter((url) => url.includes("/export"))).toHaveLength(0);
  });

  it("omits missions and tasks while retaining the other selected sections", async () => {
    openExport();
    fireEvent.click(screen.getByRole("checkbox", { name: /Missions/ }));
    const snapshot = await download();
    expect(snapshot.missions).toEqual([]);
    expect(snapshot.columns).toMatchObject([{ name: "Backlog" }]);
    const query = new URLSearchParams(requests.find((url) => url.includes("/export"))!.split("?")[1]);
    expect(query.get("include")?.split(",")).toEqual(["columns", "comments", "templates", "webhooks"]);
  });

  it.each([
    [/Columns/, "columns"], [/Comments/, "comments"],
    [/Habitat-specific templates/, "templates"], [/Webhook configurations/, "webhooks"],
  ])("retains the selection for %s", async (label, section) => {
    openExport();
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("checkbox", { name: label }));
    const snapshot = await download();
    const query = new URLSearchParams(requests.find((url) => url.includes("/export"))!.split("?")[1]);
    expect(query.get("include")).toBe(section);
    expect(snapshot.missions).toEqual([]);
    const expected: Record<string, object> = {
      columns: { name: "Backlog" }, comments: { content: "Synthetic comment" },
      templates: { name: "Synthetic template" }, webhooks: { name: "Synthetic webhook" },
    };
    for (const name of Object.keys(expected)) {
      if (section === name) expect(snapshot[name]).toMatchObject([expected[name]]);
      else expect(snapshot[name]).toEqual([]);
    }
  });


  it("preserves direct API defaults when include is omitted", async () => {
    const response = await app.inject({ method: "GET", url: `/api/habitats/${habitat.id}/export`, headers: { authorization: `Bearer ${localStorage.getItem("orcy_token")}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().habitat.missions).toMatchObject([{ title: "Synthetic mission", tasks: [{ title: "Synthetic task" }] }]);
  });


  it("surfaces a failed export and does not download a receipt", async () => {
    const error = vi.spyOn(notify, "error").mockImplementation(() => "test-error");
    habitat = { ...habitat, id: "missing-habitat" };
    openExport();
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(receipts).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
  });

});
