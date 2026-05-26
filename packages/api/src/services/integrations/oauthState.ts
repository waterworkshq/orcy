import crypto from 'crypto';

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

export function generateState(habitatId: string): string {
  cleanExpired();
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, { habitatId, createdAt: Date.now() });
  return state;
}

export function storeCodeVerifier(state: string, codeVerifier: string): void {
  const pending = pendingStates.get(state);
  if (pending) {
    pending.codeVerifier = codeVerifier;
  }
}

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

export function clearAllStates(): void {
  pendingStates.clear();
}
