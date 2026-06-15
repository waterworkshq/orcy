import crypto from "crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingState {
  habitatId: string;
  createdAt: number;
  codeVerifier?: string;
}

const pendingStates = new Map<string, PendingState>();

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (now - value.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}

/**
 * Creates a new random OAuth state token bound to a habitat and stores it in memory,
 * cleaning expired entries before doing so.
 */
export function generateState(habitatId: string): string {
  cleanExpired();
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, { habitatId, createdAt: Date.now() });
  return state;
}

/** Associates a PKCE code verifier with an existing in-memory OAuth state token. */
export function storeCodeVerifier(state: string, codeVerifier: string): void {
  const pending = pendingStates.get(state);
  if (pending) {
    pending.codeVerifier = codeVerifier;
  }
}

/**
 * Validates and removes an in-memory OAuth state token for the given habitat,
 * returning any stored PKCE code verifier. State can only be used once.
 */
export function consumeState(state: string, habitatId: string): { codeVerifier?: string } | null {
  const pending = pendingStates.get(state);
  if (!pending) return null;

  pendingStates.delete(state);

  // One-shot: state is consumed even if habitatId doesn't match.
  // This prevents replay attacks where a stolen state token is retried.
  if (pending.habitatId !== habitatId) return null;
  if (Date.now() - pending.createdAt > STATE_TTL_MS) return null;

  return { codeVerifier: pending.codeVerifier };
}

/** Clears every in-memory OAuth state token, primarily for tests. */
export function clearAllStates(): void {
  pendingStates.clear();
}
