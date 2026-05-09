import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../db/index.js', () => {
  const insertRun = vi.fn();
  const insertValues = vi.fn(() => ({ run: insertRun }));
  const insertFn = vi.fn(() => ({ values: insertValues }));

  const updateSet = vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) }));
  const updateFn = vi.fn(() => ({ set: updateSet }));

  const deleteWhere = vi.fn(() => ({ run: vi.fn() }));
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));

  const selectFromWhere = vi.fn(() => ({
    all: vi.fn(() => []),
    get: vi.fn(() => undefined),
  }));
  const selectFrom = vi.fn(() => ({ from: vi.fn(() => ({ where: selectFromWhere })) }));
  const selectFn = vi.fn(() => ({ from: selectFrom }));

  const mockDb = {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  };
  return { getDb: vi.fn(() => mockDb) };
});

vi.mock('../db/schema.js', () => ({
  boards: { id: 'id', name: 'name' },
  webhookSubscriptions: {
    id: 'id', boardId: 'boardId', name: 'name', url: 'url',
    secret: 'secret', events: 'events', headers: 'headers',
    format: 'format', enabled: 'enabled', createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
  webhookDeliveries: {
    id: 'id', subscriptionId: 'subscriptionId', eventType: 'eventType',
    payload: 'payload', status: 'status', statusCode: 'statusCode',
    responseBody: 'responseBody', attempts: 'attempts', lastAttemptAt: 'lastAttemptAt',
    nextRetryAt: 'nextRetryAt', createdAt: 'createdAt',
  },
}));

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
}));

vi.mock('../repositories/agent.js', () => ({
  getAgentById: vi.fn(),
}));

import { getDb } from '../db/index.js';
import {
  createWebhookSubscription,
  getWebhookSubscriptions,
  getWebhookSubscriptionById,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  rotateWebhookSecret,
  getDeliveriesForSubscription,
} from '../services/webhookDispatcher.js';
import { generateSecret, signPayload } from '../utils/webhookSigning.js';

describe('webhookDispatcher — integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('createWebhookSubscription', () => {
    it('creates subscription and returns it with generated secret', () => {
      const sub = createWebhookSubscription('board-1', 'Test Hook', 'https://example.com/hook', 'standard', ['task.created'], {});
      expect(sub.name).toBe('Test Hook');
      expect(sub.url).toBe('https://example.com/hook');
      expect(sub.format).toBe('standard');
      expect(sub.events).toEqual(['task.created']);
      expect(sub.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(sub.enabled).toBe(1);
    });
  });

  describe('getWebhookSubscriptions', () => {
    it('returns all when no filter', () => {
      const mockDb = getDb();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({ all: vi.fn(() => [{ id: '1', name: 'a' }]) })),
      });
      const result = getWebhookSubscriptions();
      expect(result).toEqual([{ id: '1', name: 'a' }]);
    });

    it('returns global only when null', () => {
      const mockDb = getDb();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ all: vi.fn(() => []) })) })),
      });
      getWebhookSubscriptions(null);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('getWebhookSubscriptionById', () => {
    it('returns null when not found', () => {
      const mockDb = getDb();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ get: vi.fn(() => undefined) })) })),
      });
      expect(getWebhookSubscriptionById('missing')).toBeNull();
    });

    it('returns subscription when found', () => {
      const mockDb = getDb();
      const mockSub = { id: 'sub-1', name: 'hook' };
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ get: vi.fn(() => mockSub) })) })),
      });
      expect(getWebhookSubscriptionById('sub-1')).toEqual(mockSub);
    });
  });

  describe('updateWebhookSubscription', () => {
    it('returns false when subscription not found', () => {
      const mockDb = getDb();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ get: vi.fn(() => undefined) })) })),
      });
      expect(updateWebhookSubscription('missing', { name: 'x' })).toBe(false);
    });

    it('returns true and updates when found', () => {
      const mockDb = getDb();
      const mockSub = { id: 'sub-1', name: 'old', url: 'http://a', format: 'standard', events: [], headers: {}, enabled: 1 };
      (mockDb.select as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ get: vi.fn(() => mockSub) })) })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ get: vi.fn(() => mockSub) })) })) });
      const setMock = vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) }));
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setMock });
      expect(updateWebhookSubscription('sub-1', { name: 'new' })).toBe(true);
    });
  });

  describe('deleteWebhookSubscription', () => {
    it('returns false when not found', () => {
      const mockDb = getDb();
      const getFn = vi.fn(() => undefined);
      const whereChain = { get: getFn };
      const fromChain = { where: vi.fn(() => whereChain) };
      const fromFn = vi.fn(() => fromChain);
      (mockDb.select as ReturnType<typeof vi.fn>).mockReset();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: fromFn });
      const result = deleteWebhookSubscription('missing');
      expect(fromFn).toHaveBeenCalled();
      expect(getFn).toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('returns true and deletes when found', () => {
      const mockDb = getDb();
      const whereChain = { get: vi.fn(() => ({ id: 'sub-1' })) };
      const fromChain = { where: vi.fn(() => whereChain) };
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: vi.fn(() => fromChain) });
      const runMock = vi.fn();
      (mockDb.delete as ReturnType<typeof vi.fn>).mockReturnValue({ where: vi.fn(() => ({ run: runMock })) });
      expect(deleteWebhookSubscription('sub-1')).toBe(true);
      expect(runMock).toHaveBeenCalled();
    });
  });

  describe('rotateWebhookSecret', () => {
    it('returns null when not found', () => {
      const mockDb = getDb();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ get: vi.fn(() => undefined) })) })),
      });
      expect(rotateWebhookSecret('missing')).toBeNull();
    });
  });

  describe('getDeliveriesForSubscription', () => {
    it('queries with correct limit', () => {
      const mockDb = getDb();
      const allMock = vi.fn(() => []);
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({ all: allMock })),
            })),
          })),
        })),
      });
      const result = getDeliveriesForSubscription('sub-1', 10);
      expect(result).toEqual([]);
    });
  });

  describe('signing integration', () => {
    it('generateSecret produces valid hex', () => {
      const secret = generateSecret();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signPayload produces sha256 prefixed hex', () => {
      const sig = signPayload('test', 'secret');
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });
});
