import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import { agentMessageRoutes } from "../routes/agentMessages.js";
import { isAppError } from "../errors.js";
import { enqueueNotificationWithIntents } from "../services/notificationIntentCommand.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";

vi.mock("../services/notificationIntentCommand.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/notificationIntentCommand.js")>();
  return {
    ...actual,
    enqueueNotificationWithIntents: vi.fn(
      (cmd: Parameters<typeof actual.enqueueNotificationWithIntents>[0]) =>
        actual.enqueueNotificationWithIntents(cmd),
    ),
  };
});

function mockReqRes(overrides: Record<string, unknown> = {}) {
  const request: Record<string, unknown> = {
    params: {},
    query: {},
    body: {},
    agent: undefined,
    user: undefined,
    ...overrides,
  };
  const sent: { code: number | null; body: unknown } = { code: null, body: null };
  const reply = {
    code: vi.fn((c: number) => {
      sent.code = c;
      return reply;
    }),
    send: vi.fn((b: unknown) => {
      sent.body = b;
      return reply;
    }),
    status: vi.fn((c: number) => {
      sent.code = c;
      return reply;
    }),
  };
  return { request, reply, sent };
}

async function callHandler(
  handler: (req: unknown, reply: unknown) => Promise<void>,
  request: unknown,
  reply: unknown,
  sent: { code: number | null; body: unknown },
): Promise<void> {
  try {
    await handler(request, reply);
  } catch (err: unknown) {
    if (isAppError(err)) {
      sent.code = err.statusCode;
      sent.body = { error: err.message, code: err.code, details: err.details };
      return;
    }
    throw err;
  }
}

type RouteHandler = (req: unknown, reply: unknown) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify = {
    addHook: vi.fn(),
    post: vi.fn((path: string, opts: unknown, handler: unknown) => {
      routes.push({
        method: "POST",
        path,
        handler: (typeof opts === "function" ? opts : handler) as RouteHandler,
      });
    }),
    get: vi.fn((path: string, opts: unknown, handler: unknown) => {
      routes.push({
        method: "GET",
        path,
        handler: (typeof opts === "function" ? opts : handler) as RouteHandler,
      });
    }),
    put: vi.fn((path: string, opts: unknown, handler: unknown) => {
      routes.push({
        method: "PUT",
        path,
        handler: (typeof opts === "function" ? opts : handler) as RouteHandler,
      });
    }),
    delete: vi.fn((path: string, opts: unknown, handler: unknown) => {
      routes.push({
        method: "DELETE",
        path,
        handler: (typeof opts === "function" ? opts : handler) as RouteHandler,
      });
    }),
  };
  agentMessageRoutes(fakeFastify as never);
  return routes;
}

function findRoute(routes: CapturedRoute[], method: string, pathPattern: string): RouteHandler {
  const r = routes.find((route) => route.method === method && route.path.includes(pathPattern));
  if (!r) throw new Error(`Route ${method} ${pathPattern} not found`);
  return r.handler;
}

function createDefaultSubscription(habitatId: string, eventType: string) {
  return subscriptionRepo.createSubscription({
    habitatId,
    scope: "habitat_default",
    eventType,
    enabled: true,
    required: false,
    channels: ["in_app"],
    cadence: "immediate",
  });
}

// GROUND: MIGRATION-TASKS T6 6.1 seedRemoteGrantHolder — exact constructors;
// interfaces verified: remotePod.ts:12-21, remoteParticipant.ts:16-26,
// remoteGrant.ts:29-39, notificationSubscription.ts:19-33 (CORE-TASKS §note10
// fixtures). Participant-scoped allowlist with no targets; only the old
// untargeted discovery (targetType "agent" → undefined) includes it.
function seedRemoteGrantHolder(habId: string): string {
  const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId: habId, name: "pod-grant" }).id)!;
  const p = participantRepo.activateRemoteParticipant(
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id, habitatId: habId, participantType: "remote_human",
      displayName: "Grant Holder", standing: "remote_contributor",
    }).id,
  )!;
  grantRepo.createRemoteGrant({
    habitatId: habId, remotePodId: pod.id, remoteParticipantId: p.id,
    grantType: "scoped_elevation", standing: "remote_contributor", actionScopes: ["read"],
  });
  subscriptionRepo.createSubscription({
    habitatId: habId, scope: "habitat_default", eventType: "agent.message_received",
    enabled: true, required: false, channels: ["in_app"], cadence: "immediate",
  });
  return p.id;
}

describe("agent mail Notification V2 enqueue", () => {
  let habitatId: string;
  let fromAgentId: string;
  let toAgentId: string;
  let otherAgentId: string;
  let routes: CapturedRoute[];

  beforeEach(async () => {
    await initTestDb();
    vi.mocked(enqueueNotificationWithIntents).mockClear();

    const habitat = habitatRepo.createHabitat({ name: "Mail Notify Habitat" });
    habitatId = habitat.id;

    const from = agentRepo.createAgent({ name: "mail-from", type: "claude-code", domain: "backend" });
    fromAgentId = from.agent.id;
    const to = agentRepo.createAgent({ name: "mail-to", type: "opencode", domain: "frontend" });
    toAgentId = to.agent.id;
    const other = agentRepo.createAgent({ name: "mail-other", type: "codex", domain: "devops" });
    otherAgentId = other.agent.id;

    routes = captureRoutes();
  });

  afterEach(() => {
    closeDb();
  });

  async function sendMail(opts?: { body?: string; priority?: string }) {
    const mailBody = opts?.body ?? "SECRET_MAIL_BODY_DO_NOT_NOTIFY";
    const handler = findRoute(routes, "POST", "/agents/:agentId/messages");
    const { request, reply, sent } = mockReqRes({
      params: { agentId: fromAgentId },
      body: {
        habitatId,
        toAgentId,
        subject: "Status update",
        body: mailBody,
        messageType: "info",
        priority: opts?.priority ?? "normal",
      },
      agent: { id: fromAgentId, name: "mail-from" },
    });
    await callHandler(handler, request, reply, sent);
    return { sent, mailBody };
  }

  it("delivers only to the recipient agent when a habitat_default exists", async () => {
    createDefaultSubscription(habitatId, "agent.message_received");
    const { sent } = await sendMail();

    expect(sent.code).toBe(201);

    const { events } = eventRepo.listNotificationEventsByHabitat(habitatId, {
      eventType: "agent.message_received",
    });
    expect(events).toHaveLength(1);

    const deliveries = deliveryRepo.getDeliveriesByEvent(events[0].id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].recipientType).toBe("agent");
    expect(deliveries[0].recipientId).toBe(toAgentId);
    expect(deliveries[0].recipientId).not.toBe(fromAgentId);
    expect(deliveries[0].recipientId).not.toBe(otherAgentId);
    expect(deliveries.every((d) => d.recipientType !== "human")).toBe(true);
  });

  it("returns 201 and suppresses when no subscription exists", async () => {
    const { sent } = await sendMail();

    expect(sent.code).toBe(201);

    const { events } = eventRepo.listNotificationEventsByHabitat(habitatId, {
      eventType: "agent.message_received",
    });
    expect(events.length).toBeLessThanOrEqual(1);
    if (events.length === 1) {
      const deliveries = deliveryRepo.getDeliveriesByEvent(events[0].id);
      expect(deliveries).toHaveLength(0);
    }
  });

  it("does not put the mail body on the notification event", async () => {
    createDefaultSubscription(habitatId, "agent.message_received");
    const { sent, mailBody } = await sendMail();

    expect(sent.code).toBe(201);
    const { events } = eventRepo.listNotificationEventsByHabitat(habitatId, {
      eventType: "agent.message_received",
    });
    expect(events).toHaveLength(1);
    const serialized = `${events[0].title}\n${events[0].body}\n${JSON.stringify(events[0].payload)}`;
    expect(serialized).not.toContain(mailBody);
    expect(events[0].payload).not.toHaveProperty("body");
  });

  // GROUND: MIGRATION-TASKS T6 6.1 — N1 exact audience; replaces the T1
  // "agent-mail widen" characterization cell (6.5 retirement): the active
  // remote grant holder gained a delivery under old untargeted discovery and
  // gains none under the exact intent.
  it("delivers only to the addressed agent — active remote grant holder gains no delivery (widen closed)", async () => {
    const remoteId = seedRemoteGrantHolder(habitatId);
    const { sent } = await sendMail({ body: "hello", priority: "normal" });
    expect(sent.code).toBe(201);
    expect(vi.mocked(enqueueNotificationWithIntents)).toHaveBeenCalledTimes(1);
    const cmd = vi.mocked(enqueueNotificationWithIntents).mock.calls[0][0];
    expect(cmd.intents).toEqual([
      { kind: "exact", recipients: [{ recipientType: "agent", recipientId: cmd.targetId }] },
    ]);
    expect(cmd.targetType).toBe("agent");          // event-row metadata parity kept
    const deliveries = deliveryRepo.getDeliveriesByEvent(
      eventRepo.listNotificationEventsByHabitat(cmd.habitatId).events[0]!.id, // {events,total}, newest-first
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.recipientType).toBe("agent");
    expect(deliveries.some((d) => d.recipientId === remoteId)).toBe(false);
  });

  // GROUND: MIGRATION-TASKS T6 6.1 — subject-only projection (N10 payload
  // parity): the message body never enters the notification payload.
  it("payload stays subject-only — the message body never enters the notification payload", async () => {
    await sendMail({ body: "SECRET-BODY" });
    const cmd = vi.mocked(enqueueNotificationWithIntents).mock.calls[0][0];
    expect(cmd.payload).toHaveProperty("subject");
    expect(JSON.stringify(cmd.payload)).not.toContain("SECRET-BODY");
  });

  // GROUND: MIGRATION-TASKS T6 6.1 — best-effort primary action retained;
  // supersedes the old enqueueNotification-throw test.
  it("enqueue failure does not fail the 201 (best-effort retained)", async () => {
    createDefaultSubscription(habitatId, "agent.message_received");
    vi.mocked(enqueueNotificationWithIntents).mockImplementationOnce(() => { throw new Error("boom"); });
    const { sent } = await sendMail({});
    expect(sent.code).toBe(201);
  });
});
