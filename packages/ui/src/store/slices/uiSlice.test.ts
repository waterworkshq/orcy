import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createUiSlice } from './uiSlice.js';
import type { UiSlice } from './uiSlice.js';

type SetFn = Parameters<typeof createUiSlice>[0];

describe('uiSlice - addNotification', () => {
  let set: SetFn & Mock;
  let slice: UiSlice;

  beforeEach(() => {
    set = vi.fn() as unknown as (SetFn & Mock);
    slice = createUiSlice(set, vi.fn() as never, {} as never);
  });

  it('should add a notification with an id and read: false', () => {
    slice.addNotification({ type: 'info', taskId: 't-1', taskTitle: 'T', message: 'm', timestamp: 'now' });
    const updater = set.mock.calls[0][0] as (s: Partial<UiSlice>) => Partial<UiSlice>;
    const result = updater({ notifications: [] });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications![0].read).toBe(false);
    expect(result.notifications![0].id).toBeDefined();
  });

  it('should prepend new notifications', () => {
    slice.addNotification({ type: 'info', taskId: 't-1', taskTitle: 'T', message: 'm', timestamp: 'now' });
    const cb = set.mock.calls[0][0] as (s: Partial<UiSlice>) => Partial<UiSlice>;
    const r1 = cb({ notifications: [] });
    const r2 = cb({ notifications: r1.notifications ?? [] });
    expect(r2.notifications).toHaveLength(2);
  });

  it('should limit notifications to 100', () => {
    slice.addNotification({ type: 'info', taskId: 't-1', taskTitle: 'T', message: 'm', timestamp: 'now' });
    const cb = set.mock.calls[0][0] as (s: Partial<UiSlice>) => Partial<UiSlice>;
    const existing = Array.from({ length: 100 }, (_, i) => ({
      id: `notif-${i}`,
      type: 'info',
      taskId: 't-1',
      taskTitle: 'Task',
      message: 'msg',
      timestamp: new Date().toISOString(),
      read: false,
    }));
    const result = cb({ notifications: existing });
    expect(result.notifications).toHaveLength(100);
    expect(result.notifications![0].id).toBeDefined();
    expect(result.notifications![99].id).toBe('notif-98');
  });

  it('should fallback when crypto.randomUUID is unavailable', () => {
    const orig = crypto.randomUUID;
    (crypto as Partial<Crypto>).randomUUID = undefined as unknown as typeof crypto.randomUUID;

    slice.addNotification({ type: 'info', taskId: 't-1', taskTitle: 'T', message: 'm', timestamp: 'now' });
    const cb = set.mock.calls[0][0] as (s: Partial<UiSlice>) => Partial<UiSlice>;
    const result = cb({ notifications: [] });
    expect(result.notifications![0].id).toMatch(/^notif-/);

    (crypto as Partial<Crypto>).randomUUID = orig;
  });
});
