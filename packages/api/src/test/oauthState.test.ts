import { describe, it, expect, beforeEach } from 'vitest';
import { generateState, storeCodeVerifier, consumeState, clearAllStates } from '../services/integrations/oauthState.js';

describe('oauthState', () => {
  beforeEach(() => {
    clearAllStates();
  });

  it('generates state and consumes it with matching habitatId', () => {
    const state = generateState('hab-1');
    expect(state).toBeTruthy();

    const result = consumeState(state, 'hab-1');
    expect(result).not.toBeNull();
  });

  it('returns codeVerifier when stored', () => {
    const state = generateState('hab-1');
    storeCodeVerifier(state, 'verifier-123');

    const result = consumeState(state, 'hab-1');
    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe('verifier-123');
  });

  it('rejects mismatched habitatId', () => {
    const state = generateState('hab-1');
    const result = consumeState(state, 'hab-2');
    expect(result).toBeNull();
  });

  it('rejects unknown state', () => {
    const result = consumeState('nonexistent-state', 'hab-1');
    expect(result).toBeNull();
  });

  it('state can only be consumed once', () => {
    const state = generateState('hab-1');
    const first = consumeState(state, 'hab-1');
    expect(first).not.toBeNull();

    const second = consumeState(state, 'hab-1');
    expect(second).toBeNull();
  });

  it('generates different states each time', () => {
    const state1 = generateState('hab-1');
    const state2 = generateState('hab-1');
    expect(state1).not.toBe(state2);
  });
});
