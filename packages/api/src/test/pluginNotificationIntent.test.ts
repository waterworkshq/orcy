// GROUND: T9 (MIGRATION-TASKS 9.1) — plugin seam exact intent, producer label P8.
// PRD N1: "Only named eligible typed identities; no implicit remote augmentation.
// Plugin notification capability remains explicit-only, scoped/capped/provenance-stamped."
// DESIGN §7 P8 disposition: "P1, P4 and P8 lose the unintended untargeted augmentation
// entirely (typed local intents only)". DESIGN §2 plugins/context row: "Exact local
// identities, unchanged capability scope, provenance and write caps; no role intents
// granted to plugins."
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { users, teamMembers, teams, organizations, habitats } from "../db/schema/index.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { buildPluginContext } from "../plugins/context.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";

let habitatId: string;
let memberUserId: string;
beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
  const teamId = `team-${crypto.randomUUID().slice(0, 8)}`;
  habitatId = `hab-${crypto.randomUUID().slice(0, 8)}`;
  memberUserId = "plug-member";
  db.insert(organizations).values({ id: orgId, name: "O", slug: orgId }).run();
  db.insert(teams).values({ id: teamId, organizationId: orgId, name: "T", slug: teamId }).run();
  db.insert(users).values({ id: memberUserId, username: memberUserId, passwordHash: "x", displayName: memberUserId, role: "editor" }).run();
  db.insert(teamMembers).values({ id: `tm-${crypto.randomUUID().slice(0, 8)}`, teamId, userId: memberUserId, role: "member" }).run();
  db.insert(habitats).values({ id: habitatId, name: "H", teamId }).run();
  subscriptionRepo.createSubscription({ habitatId, scope: "habitat_default", eventType: "task.blocked",
    enabled: true, required: false, channels: ["in_app"], cadence: "immediate" });
});
afterEach(async () => { await closeDb(); delete process.env.ORCY_PLUGIN_WRITE_CAP; });

function sender() {
  const ctx = buildPluginContext({ pluginId: "p1", contributionId: "c1", habitatId, runId: "r1",
    requires: ["notificationSender"] });
  return ctx.notificationSender!;
}

describe("plugin notificationSender → exact intent (P8)", () => {
  // GROUND: PRD N1 — only the plugin-supplied exact set is delivered (no implicit
  // remote augmentation) and the provenance stamp (payload.pluginId, createdById
  // "plugin:<id>") survives the intent seam.
  it("valid recipient id delivers to exactly the plugin-supplied set; provenance payload intact", async () => {
    const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId, name: "plugin-peer" }).id)!;
    const peer = participantRepo.activateRemoteParticipant(participantRepo.createRemoteParticipant({
      habitatId, remotePodId: pod.id, participantType: "remote_human", displayName: "Peer", standing: "remote_contributor",
    }).id)!;
    grantRepo.createRemoteGrant({ habitatId, remotePodId: pod.id, remoteParticipantId: peer.id,
      grantType: "scoped_elevation", standing: "remote_contributor", actionScopes: ["read"] });
    const out = await sender().notify({ eventType: "task.blocked", severity: "warning",
      recipients: [{ recipientType: "human", recipientId: memberUserId }], template: "T" });
    expect(out.deliveryCount).toBe(1);
    const event = eventRepo.listNotificationEventsByHabitat(habitatId).events[0]!;
    expect(deliveryRepo.getDeliveriesByEvent(event.id).map((d) => [d.recipientType, d.recipientId]))
      .toEqual([["human", memberUserId]]);
    expect(event.payload).toMatchObject({ renderedTemplate: "T", pluginId: "p1" });
    expect(event.createdById).toBe("plugin:p1");
  });
  // GROUND: PRD N1 + DESIGN §3 exact intent — invalid identity fails the whole
  // action with bounded diagnostics; PRD §5 preflight: zero notification writes
  // (no Event insertion) on invalid/ambiguous intent.
  it("nonexistent recipient id fails closed with zero writes (adopted N1 — was an undiscriminated delivery to any id string whenever the seeded plain default exists)", async () => {
    await expect(sender().notify({ eventType: "task.blocked",
      recipients: [{ recipientType: "human", recipientId: "no-such-user" }], template: "T" }))
      .rejects.toThrow("INVALID_EXACT_RECIPIENT");
    expect(eventRepo.listNotificationEventsByHabitat(habitatId).events).toHaveLength(0);
  });
  // GROUND: DESIGN §3 exact intent — "Explicit local human/agent identities …
  // No remote augmentation"; PRD N1 plugin restriction (plugins are external
  // callers, so a mistyped remote recipient form must fail, not deliver).
  it("remote id in plugin recipients is rejected (exact intent admits only local human/agent)", async () => {
    // plugins are external callers: a runtime-remote recipient is deliberately mistyped here
    // because PluginNotificationInput only admits human|agent at the type level
    const badInput = {
      eventType: "task.blocked", template: "T",
      recipients: [{ recipientType: "remote_human", recipientId: "r-1" }],
    } as unknown as Parameters<ReturnType<typeof sender>["notify"]>[0];
    await expect(sender().notify(badInput)).rejects.toThrow();
  });
  // GROUND: PRD N1 — "Plugin notification capability remains explicit-only,
  // scoped/capped/provenance-stamped"; pins the write-cap gate staying ABOVE the
  // enqueue call in the 9.2 patch ordering (cap enforced before any enqueue).
  it("write cap still enforced before any enqueue", async () => {
    // Pin the cap explicitly: an ambient ORCY_PLUGIN_WRITE_CAP (e.g. a non-numeric
    // value → NaN) would silently skip the loop and defang the expected rejection.
    process.env.ORCY_PLUGIN_WRITE_CAP = "3";
    const ctx = buildPluginContext({ pluginId: "p1", contributionId: "c1", habitatId, runId: "r1",
      requires: ["notificationSender"] });
    for (let i = 0; i < 3; i++) {
      await ctx.notificationSender!.notify({ eventType: "task.blocked",
        recipients: [{ recipientType: "human", recipientId: memberUserId }], template: "T" });
    }
    await expect(ctx.notificationSender!.notify({ eventType: "task.blocked",
      recipients: [{ recipientType: "human", recipientId: memberUserId }], template: "T" }))
      .rejects.toThrow("Plugin write cap exceeded");
  });
});
