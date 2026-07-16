import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as templateRepo from "../repositories/template.js";
import { templateRoutes } from "../routes/templates.js";
import { registerErrorHandler } from "../errors/plugin.js";
import {
  missionTemplates,
  missions,
  columns as columnsTable,
  habitats,
  tasks,
} from "../db/schema/index.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(templateRoutes);
  await f.ready();
  return f;
}

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  habitatId = habitat.id;

  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(async () => {
  closeDb();
});

const VALID_WORKFLOW_TEMPLATE = {
  gates: [
    {
      upstreamTaskKey: "task_a",
      downstreamTaskKey: "task_b",
      gateType: "on_complete" as const,
    },
  ],
  variables: [{ key: "feature_name", description: "Name of the feature being built" }],
};

describe("templateRoutes — workflowTemplate passthrough", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST creates a template with workflowTemplate and GET returns it", async () => {
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

    const createRes = await app.inject({
      method: "POST",
      url: `/habitats/${habitatId}/templates`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Workflow Template",
        titlePattern: "Task {{n}}",
        workflowTemplate: VALID_WORKFLOW_TEMPLATE,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body).template;
    expect(created.workflowTemplate).toEqual(VALID_WORKFLOW_TEMPLATE);

    // Round-trip via the repository layer (the GET route is `/habitats/:id/templates`).
    const fetched = templateRepo.getTemplateById(created.id);
    expect(fetched?.workflowTemplate).toEqual(VALID_WORKFLOW_TEMPLATE);
  });

  it("POST accepts workflowTemplate: null (no workflow)", async () => {
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

    const createRes = await app.inject({
      method: "POST",
      url: `/habitats/${habitatId}/templates`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "No Workflow",
        titlePattern: "Plain task",
        workflowTemplate: null,
      },
    });

    expect(createRes.statusCode).toBe(201);
    expect(JSON.parse(createRes.body).template.workflowTemplate).toBeNull();
  });

  it("PATCH updates an existing template's workflowTemplate", async () => {
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Patchable",
      titlePattern: "T",
      createdBy: "admin-1",
    });
    expect(template.workflowTemplate).toBeNull();

    const updatedWorkflow = {
      gates: [
        {
          upstreamTaskKey: "a",
          downstreamTaskKey: "b",
          gateType: "on_approve" as const,
        },
      ],
    };

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/templates/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { workflowTemplate: updatedWorkflow },
    });

    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).template.workflowTemplate).toEqual(updatedWorkflow);

    // PATCH back to null.
    const patchRes2 = await app.inject({
      method: "PATCH",
      url: `/templates/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { workflowTemplate: null },
    });

    expect(patchRes2.statusCode).toBe(200);
    expect(JSON.parse(patchRes2.body).template.workflowTemplate).toBeNull();
  });
});

describe("error plugin — TemplateValidationError maps to 400", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 400 (not 500) when applyTemplate throws TemplateValidationError", async () => {
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Mission",
      createdBy: "admin-1",
    });

    // A workflow that references a task key that doesn't exist in the template's tasks.
    const badWorkflow = {
      gates: [
        {
          upstreamTaskKey: "ghost_key",
          downstreamTaskKey: "also_ghost",
          gateType: "on_complete" as const,
        },
      ],
    };

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Bad Refs",
      titlePattern: "T",
      tasksTemplate: [{ title: "Only task" }],
      workflowTemplate: badWorkflow,
      createdBy: "admin-1",
    });

    const res = await app.inject({
      method: "POST",
      url: `/missions/${mission.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toMatch(/ghost_key|unknown task key|invalid|missing/i);
  });

  it("returns 201 on a valid applyTemplate (no TemplateValidationError)", async () => {
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Mission 2",
      createdBy: "admin-1",
    });

    const goodWorkflow = {
      gates: [
        {
          upstreamTaskKey: "task_a",
          downstreamTaskKey: "task_b",
          gateType: "on_complete" as const,
        },
      ],
    };

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Good Refs",
      titlePattern: "T",
      tasksTemplate: [
        { title: "A", key: "task_a" },
        { title: "B", key: "task_b" },
      ],
      workflowTemplate: goodWorkflow,
      createdBy: "admin-1",
    });

    const res = await app.inject({
      method: "POST",
      url: `/missions/${mission.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.workflow).not.toBeNull();
    expect(body.workflow.status).toBe("active");
  });
});
