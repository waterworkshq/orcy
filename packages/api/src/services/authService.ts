import * as userRepo from "../repositories/user.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { forbidden } from "../errors.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/** Returns whether the instance still needs initial setup, which is true while no users exist. */
export function getSetupStatus(): { needsSetup: boolean } {
  return { needsSetup: userRepo.countUsers() === 0 };
}

/** Creates the first admin user during initial setup and returns a 24h JWT session token. Throws if setup was already completed. */
export function registerInitialAdmin(input: {
  username: string;
  password: string;
  displayName?: string;
}): { token: string; user: { id: string; username: string; role: string; displayName: string } } {
  if (userRepo.countUsers() > 0) {
    throw forbidden("Setup already completed", "SETUP_ALREADY_COMPLETED");
  }

  const passwordHash = bcrypt.hashSync(input.password, 10);
  const id = uuidv4();
  const now = new Date().toISOString();

  userRepo.createUser({
    id,
    username: input.username,
    passwordHash,
    displayName: input.displayName,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });

  const token = jwt.sign({ sub: id, username: input.username, role: "admin" }, getJwtSecret(), {
    expiresIn: "24h",
    issuer: "orcy",
  });

  return {
    token,
    user: { id, username: input.username, role: "admin", displayName: input.displayName ?? "" },
  };
}

/** Returns the current user's profile from the database, falling back to the JWT claims when the row is missing. */
export function getCurrentUserProfile(user: { id: string; username: string; role: string }): {
  user: { id: string; username: string; role: string; displayName: string };
} {
  const row = userRepo.getUserById(user.id);
  if (!row) {
    return { user: { id: user.id, username: user.username, role: user.role, displayName: "" } };
  }
  return {
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      displayName: row.displayName ?? "",
    },
  };
}
