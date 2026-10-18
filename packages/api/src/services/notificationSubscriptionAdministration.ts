import { getDb } from "../db/index.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { notFound, forbidden } from "../errors.js";
import { habitats } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { getMember } from "../repositories/teamMember.js";

function requireCurrentHabitatAccess(tx: ReturnType<typeof getDb>, habitatId: string, userId: string) {
  const habitat = tx.select({ teamId: habitats.teamId }).from(habitats)
    .where(eq(habitats.id, habitatId)).get();
  if (!habitat) throw notFound("Habitat not found");
  // Match the human admission policy: all authenticated humans may administer
  // personal Habitats, and any current Team member may administer Team Habitats.
  if (habitat.teamId && !getMember(habitat.teamId, userId, tx)) {
    throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
  }
}

/** Owns the reservation for human subscription administration. */
export function updateHabitatSubscription(
  habitatId: string,
  subscriptionId: string,
  userId: string,
  updates: Parameters<typeof subscriptionRepo.updateSubscription>[1],
) {
  return getDb().transaction((tx) => {
    requireCurrentHabitatAccess(tx, habitatId, userId);
    if (!subscriptionRepo.getSubscriptionInHabitat(subscriptionId, habitatId, tx)) {
      throw notFound("Subscription not found");
    }
    const updated = subscriptionRepo.updateSubscriptionInHabitat(subscriptionId, habitatId, updates, tx);
    if (!updated) throw notFound("Subscription not found");
    return updated;
  }, { behavior: "immediate" });
}

export function deleteHabitatSubscription(habitatId: string, subscriptionId: string, userId: string) {
  return getDb().transaction((tx) => {
    requireCurrentHabitatAccess(tx, habitatId, userId);
    if (!subscriptionRepo.getSubscriptionInHabitat(subscriptionId, habitatId, tx)) return false;
    return subscriptionRepo.deleteSubscriptionInHabitat(subscriptionId, habitatId, tx);
  }, { behavior: "immediate" });
}
