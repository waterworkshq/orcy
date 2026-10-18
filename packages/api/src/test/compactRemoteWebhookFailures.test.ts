import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// DNS and fetch are the external network boundaries. Persistence, recipient
// resolution and SSE subscriptions exercise the actual application services.
vi.mock("node:dns", () => ({
  promises: {
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => [],
  },
}));

import { closeDb, getDb, initTestDb } from "../db/index.js";
import { notificationDeliveries, notificationEvents, notificationSubscriptions, users } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as podRepo from "../repositories/remotePod.js";
import * as endpointRepo from "../repositories/remoteWebhookEndpoint.js";
import * as deliveryRepo from "../repositories/remoteWebhookDelivery.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import { getActiveInbox } from "../repositories/notificationDelivery.js";
import { createSubscription } from "../repositories/notificationSubscription.js";
import { getAdmins } from "../repositories/user.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import {
  dispatchCompactRemoteEvent,
  forgetEndpointPlaintextSecret,
  registerEndpointPlaintextSecret,
  type RemoteEventDispatchInput,
} from "../services/compactRemoteWebhookDispatcher.js";

const fetchMock = vi.fn<typeof fetch>();
const unsubscribers: Array<() => void> = [];
const endpointIds: string[] = [];

function setupDispatch() {
  const habitat = habitatRepo.createHabitat({ name: "Remote webhook failure visibility" });
  createSubscription({ habitatId: habitat.id, scope: "habitat_default", eventType: "webhook.delivery_failed", channels: ["in_app"] });
  const pod = podRepo.createRemotePod({ habitatId: habitat.id, name: "Remote Pod" });
  podRepo.activateRemotePod(pod.id);
  const endpoint = addEndpoint(habitat.id, pod.id);
  const input: RemoteEventDispatchInput = {
    habitatId: habitat.id,
    eventType: "task.assigned",
    apiBase: "https://orcy.example.com/api/shared",
    payload: {
      eventType: "task.assigned",
      occurredAt: "2026-10-18T00:00:00.000Z",
      habitatId: habitat.id,
      actor: { type: "remote_orcy", id: "remote-1", displayName: "Worker", podId: pod.id, podName: pod.name },
      standing: "remote_contributor",
      actionKind: "advisory",
      title: "Task assigned",
      apiBase: "https://orcy.example.com/api/shared",
      followUpPath: "/api/shared/me",
      followUpDescription: "Fetch participant",
    },
  };
  const received: unknown[] = [];
  unsubscribers.push(sseBroadcaster.subscribe(habitat.id, (event) => received.push(event)));
  return { habitat, pod, endpoint, input, received };
}

function addEndpoint(habitatId: string, podId: string) {
  const endpoint = endpointRepo.createRemoteWebhookEndpoint({
    habitatId,
    remotePodId: podId,
    url: `https://example.com/webhook/${endpointIds.length}`,
    events: ["task.assigned"],
  });
  endpointRepo.approveRemoteWebhookEndpoint(endpoint.id, "admin-1");
  endpointRepo.enableRemoteWebhookEndpoint(endpoint.id, "admin-1");
  registerEndpointPlaintextSecret(endpoint.id, "orcy_test_secret");
  endpointIds.push(endpoint.id);
  return endpoint;
}

function notifications(habitatId: string) {
  return getDb().select().from(notificationEvents).where(eq(notificationEvents.habitatId, habitatId)).all();
}

beforeEach(async () => {
  await initTestDb();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  for (const id of endpointIds.splice(0)) forgetEndpointPlaintextSecret(id);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  closeDb();
});

describe("Compact remote webhook failure visibility", () => {
  it("reports an HTTP rejection once through real SSE and admin notifications", async () => {
    const { habitat, endpoint, input, received } = setupDispatch();
    fetchMock.mockResolvedValue(new Response("receiver-private-detail", { status: 401, statusText: "private status text" }));

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 0, failed: 1, skipped: 0 });
    expect(received).toEqual([{
      type: "webhook.delivery_failed",
      data: { habitatId: habitat.id, endpointId: endpoint.id, endpointUrl: endpoint.url, error: "HTTP 401" },
    }]);
    const ledger = deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(endpoint.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "failed", statusCode: 401, responseBody: "receiver-private-detail", attempts: 1 });
    const events = notifications(habitat.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "webhook.delivery_failed", severity: "warning", payload: { endpointUrl: endpoint.url, error: "HTTP 401" } });
    const deliveries = getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, events[0].id)).all();
    expect(deliveries.map((row) => row.recipientId).sort()).toEqual(getAdmins().map((admin) => admin.id).sort());
    expect(JSON.stringify(received) + JSON.stringify(events)).not.toContain("receiver-private-detail");
    expect(JSON.stringify(received) + JSON.stringify(events)).not.toContain("private status text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the HTTP failure reason when its status write fails and continues to the next endpoint", async () => {
    const { habitat, pod, endpoint, input, received } = setupDispatch();
    const second = addEndpoint(habitat.id, pod.id);
    // Reject only the HTTP-status write for the first endpoint. The existing
    // null-status fallback can still settle its delivery once.
    getDb().run(sql`CREATE TRIGGER reject_remote_status BEFORE UPDATE ON remote_webhook_deliveries WHEN NEW.status_code = 401 BEGIN SELECT RAISE(ABORT, 'remote ledger unavailable'); END`);
    fetchMock.mockImplementation(async (url) => new Response(
      String(url) === endpoint.url ? "private receiver body" : "accepted",
      { status: String(url) === endpoint.url ? 401 : 202 },
    ));

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 1, failed: 1, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received).toEqual([{
      type: "webhook.delivery_failed",
      data: { habitatId: habitat.id, endpointId: endpoint.id, endpointUrl: endpoint.url, error: "HTTP 401" },
    }]);
    expect(notifications(habitat.id)).toEqual([
      expect.objectContaining({ payload: { endpointUrl: endpoint.url, error: "HTTP 401" } }),
    ]);
    expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(endpoint.id)).toEqual([
      expect.objectContaining({ status: "failed", statusCode: null, responseBody: "Failed to update remoteWebhookDelivery", attempts: 1 }),
    ]);
    expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(second.id)).toEqual([
      expect.objectContaining({ status: "success", statusCode: 202, responseBody: "accepted", attempts: 1 }),
    ]);
  });

  it.each(["default", "disabled", "muted", "no_default"] as const)(
    "binds the Habitat notification target and preserves scoped recipient policy with %s subscriptions",
    async (policy) => {
      const { habitat, pod, endpoint, input, received } = setupDispatch();
      const otherHabitat = habitatRepo.createHabitat({ name: "Other notification Habitat" });
      const otherPod = podRepo.createRemotePod({ habitatId: otherHabitat.id, name: "Other Pod" });
      podRepo.activateRemotePod(otherPod.id);
      const makeParticipant = (name: string, ownHabitatId = habitat.id, ownPodId = pod.id, active = true) => {
        const participant = participantRepo.createRemoteParticipant({
          habitatId: ownHabitatId, remotePodId: ownPodId, participantType: "remote_orcy",
          displayName: name, standing: "remote_observer",
        });
        if (active) participantRepo.activateRemoteParticipant(participant.id);
        return participant;
      };
      const cover = (participantId: string, ownHabitatId = habitat.id, ownPodId = pod.id,
        targetId = habitat.id, expiresAt?: string) => {
        const grant = grantRepo.createRemoteGrant({
          habitatId: ownHabitatId, remotePodId: ownPodId, remoteParticipantId: participantId,
          grantType: "scoped_elevation", standing: "remote_observer", actionScopes: ["read"], expiresAt,
        });
        grantRepo.addRemoteGrantTarget(grant.id, "habitat", targetId);
      };
      const covered = makeParticipant("Covered observer");
      cover(covered.id);
      const absent = makeParticipant("No grant");
      const expired = makeParticipant("Expired grant");
      cover(expired.id, habitat.id, pod.id, habitat.id, "2000-01-01T00:00:00.000Z");
      const wrongTarget = makeParticipant("Other target");
      cover(wrongTarget.id, habitat.id, pod.id, otherHabitat.id);
      const wrongHabitat = makeParticipant("Other Habitat", otherHabitat.id, otherPod.id);
      cover(wrongHabitat.id, otherHabitat.id, otherPod.id, otherHabitat.id);
      const inactive = makeParticipant("Pending participant", habitat.id, pod.id, false);
      cover(inactive.id);
      const admins = getAdmins();
      expect(admins.length).toBeGreaterThan(0);
      const filteredAdmin = admins[0].id;
      if (policy === "no_default") {
        getDb().delete(notificationSubscriptions).where(eq(notificationSubscriptions.habitatId, habitat.id)).run();
      } else if (policy !== "default") {
        for (const [recipientType, recipientId] of [["human", filteredAdmin], ["remote_orcy", covered.id]] as const) {
          createSubscription({
            habitatId: habitat.id, scope: "recipient_override", eventType: "webhook.delivery_failed",
            recipientType, recipientId, channels: ["in_app"], enabled: policy !== "disabled",
            muteUntil: policy === "muted" ? "2999-01-01T00:00:00.000Z" : undefined,
          });
        }
      }
      fetchMock.mockResolvedValue(new Response("private receiver body", { status: 403 }));

      expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 0, failed: 1, skipped: 0 });
      const events = notifications(habitat.id);
      expect(events).toHaveLength(1);
      const deliveries = getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, events[0].id)).all();
      const expected = policy === "no_default" ? [] : [
        ...admins.filter((admin) => policy === "default" || admin.id !== filteredAdmin).map((admin) => `human:${admin.id}`),
        ...(policy === "default" ? [`remote_orcy:${covered.id}`] : []),
      ];
      expect(deliveries.map((row) => `${row.recipientType}:${row.recipientId}`).sort()).toEqual(expected.sort());
      expect(events[0]).toMatchObject({ sourceId: endpoint.id, targetType: "habitat", targetId: habitat.id });
      expect(events[0].payload).toEqual({ endpointUrl: endpoint.url, error: "HTTP 403" });
      expect(getActiveInbox(habitat.id, "remote_orcy", covered.id).total).toBe(policy === "default" ? 1 : 0);
      for (const participant of [absent, expired, wrongTarget, wrongHabitat, inactive]) {
        expect(getActiveInbox(habitat.id, "remote_orcy", participant.id)).toEqual({ deliveries: [], total: 0 });
      }
      expect(getActiveInbox(otherHabitat.id, "remote_orcy", covered.id)).toEqual({ deliveries: [], total: 0 });
      expect(received).toEqual([expect.objectContaining({ data: expect.objectContaining({ endpointId: endpoint.id, error: "HTTP 403" }) })]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves HTTP settlement and other reporting when an SSE subscriber throws", async () => {
    const { habitat, pod, endpoint, input, received } = setupDispatch();
    const second = addEndpoint(habitat.id, pod.id);
    unsubscribers.push(sseBroadcaster.subscribe(habitat.id, () => { throw new Error("subscriber failed"); }));
    fetchMock.mockImplementation(async () => new Response("rejected", { status: 500 }));

    await expect(dispatchCompactRemoteEvent(input)).resolves.toEqual({ dispatched: 0, failed: 2, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);
    expect(notifications(habitat.id)).toHaveLength(2);
    for (const id of [endpoint.id, second.id]) {
      expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(id)).toEqual([
        expect.objectContaining({ status: "failed", statusCode: 500, responseBody: "rejected", attempts: 1 }),
      ]);
    }
  });


  it.each([302, 403, 429, 500])("reports HTTP %i exactly once without echoing the receiver response", async (status) => {
    const { habitat, endpoint, input, received } = setupDispatch();
    fetchMock.mockResolvedValue(new Response("private receiver body", { status, statusText: "private reason" }));

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 0, failed: 1, skipped: 0 });
    expect(received).toEqual([expect.objectContaining({ data: expect.objectContaining({ endpointId: endpoint.id, error: `HTTP ${status}` }) })]);
    expect(notifications(habitat.id)).toEqual([expect.objectContaining({ payload: { endpointUrl: endpoint.url, error: `HTTP ${status}` } })]);
    expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(endpoint.id)).toEqual([
      expect.objectContaining({ status: "failed", statusCode: status, responseBody: "private receiver body", attempts: 1 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 202])("keeps successful HTTP %i deliveries free of failure signals", async (status) => {
    const { habitat, endpoint, input, received } = setupDispatch();
    fetchMock.mockResolvedValue(new Response("accepted", { status }));

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 1, failed: 0, skipped: 0 });
    expect(received).toEqual([]);
    expect(notifications(habitat.id)).toEqual([]);
    expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(endpoint.id)).toEqual([
      expect.objectContaining({ status: "success", statusCode: status, responseBody: "accepted", attempts: 1 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("connection reset"),
    new DOMException("request timed out", "TimeoutError"),
  ])("preserves one signal per transport failure: %s", async (error) => {
    const { habitat, endpoint, input, received } = setupDispatch();
    fetchMock.mockRejectedValue(error);

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 0, failed: 1, skipped: 0 });
    expect(received).toEqual([expect.objectContaining({ data: expect.objectContaining({ error: error.message }) })]);
    expect(notifications(habitat.id)).toEqual([expect.objectContaining({ payload: { endpointUrl: endpoint.url, error: error.message } })]);
    expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(endpoint.id)).toEqual([
      expect.objectContaining({ status: "failed", statusCode: null, responseBody: error.message, attempts: 1 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still publishes SSE when there are no admin notification recipients", async () => {
    const { habitat, input, received } = setupDispatch();
    getDb().update(users).set({ role: "viewer" }).run();
    expect(getAdmins()).toEqual([]);
    fetchMock.mockResolvedValue(new Response("rejected", { status: 500 }));

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 0, failed: 1, skipped: 0 });
    expect(received).toHaveLength(1);
    expect(notifications(habitat.id)).toEqual([]);
    expect(getDb().select().from(notificationDeliveries).all()).toEqual([]);
  });

  it("does not reclassify deliveries or repeat reporting after a native notification insert failure", async () => {
    const { habitat, pod, endpoint, input, received } = setupDispatch();
    const second = addEndpoint(habitat.id, pod.id);
    // Real SQLite fault after the notification event has been persisted. This
    // catches retries that would duplicate partially completed reporting.
    getDb().run(sql`CREATE TRIGGER reject_notification_delivery BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT, 'notification storage unavailable'); END`);
    fetchMock.mockImplementation(async () => new Response("rejected", { status: 401 }));

    expect(await dispatchCompactRemoteEvent(input)).toEqual({ dispatched: 0, failed: 2, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);
    expect(notifications(habitat.id)).toHaveLength(2);
    expect(getDb().select().from(notificationDeliveries).all()).toEqual([]);
    for (const id of [endpoint.id, second.id]) {
      expect(deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(id)).toEqual([
        expect.objectContaining({ status: "failed", statusCode: 401, responseBody: "rejected", attempts: 1 }),
      ]);
    }
  });

});
