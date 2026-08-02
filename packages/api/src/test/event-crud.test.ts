import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskEvents } from "../db/schema/index.js";
import { RepositoryError } from "../errors/repository.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrud from "../repositories/taskCrud.js";
import {
  createEvent,
  createEventWithClient,
  getEventById,
  type EventDbClient,
} from "../repositories/events/event-crud.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";

let taskId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Event CRUD Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Event CRUD Mission",
    createdBy: "user-1",
  });
  taskId = taskCrud.createTask({
    missionId: mission.id,
    title: "Event CRUD Task",
    createdBy: "user-1",
  }).id;
});

afterEach(() => closeDb());

function asEventClient(client: FailingDbClient): EventDbClient {
  return client as unknown as EventDbClient;
}

describe("createEventWithClient", () => {
  it("inserts and reads back the preallocated event on the passed client", () => {
    const client = new FailingDbClient(getDb(), { failAtWriteN: null });

    const event = createEventWithClient(asEventClient(client), {
      id: "event-preallocated-1",
      taskId,
      actorType: "system",
      actorId: "system",
      action: "created",
      metadata: { source: "tx-aware-test" },
    });

    expect(event).toMatchObject({
      id: "event-preallocated-1",
      taskId,
      actorType: "system",
      actorId: "system",
      action: "created",
      metadata: { source: "tx-aware-test" },
    });
    expect(client.writeCount).toBe(1);
    expect(client.readCount).toBe(1);
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.id, "event-preallocated-1")).get(),
    ).toEqual(event);
  });

  it("propagates an INSERT failure instead of swallowing it", () => {
    let client: FailingDbClient | undefined;
    let thrown: unknown;
    try {
      getDb().transaction((tx) => {
        tx.insert(taskEvents)
          .values({
            id: "event-rollback-sentinel",
            taskId,
            actorType: "system",
            actorId: "system",
            action: "created",
            metadata: {},
            timestamp: new Date().toISOString(),
          })
          .run();

        client = new FailingDbClient(tx as unknown as EventDbClient, { failAtWriteN: 1 });
        createEventWithClient(asEventClient(client), {
          id: "event-insert-failure",
          taskId,
          actorType: "system",
          actorId: "system",
          action: "created",
        });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RepositoryError);
    expect(thrown).toMatchObject({
      entity: "taskEvent",
      operation: "create",
      entityId: "event-insert-failure",
    });
    expect(client?.writeCount).toBe(1);
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.id, "event-insert-failure")).all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.id, "event-rollback-sentinel")).all(),
    ).toHaveLength(0);
  });

  it("leaves the existing createEvent path unchanged for non-transaction callers", () => {
    const event = createEvent({
      taskId,
      actorType: "human",
      actorId: "user-1",
      action: "updated",
      metadata: { source: "existing-path" },
    });

    expect(event).toMatchObject({
      taskId,
      actorType: "human",
      actorId: "user-1",
      action: "updated",
      metadata: { source: "existing-path" },
    });
    expect(getEventById(event.id)).toEqual(event);
  });
});
