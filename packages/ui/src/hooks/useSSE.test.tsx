import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useSSE } from './useSSE.js';

const mockHandleSSEEvent = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockClose = vi.fn();

vi.mock('../store/habitatStore.js', () => ({
  useHabitatStore: (sel: (s: any) => any) =>
    sel({ handleSSEEvent: mockHandleSSEEvent, tasks: [] }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<any>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

const originalEventSource = globalThis.EventSource;

function createMockEventSource() {
  let _onmessage: ((e: { data: string }) => void) | null = null;
  let _onerror: (() => void) | null = null;
  const es: any = {};
  Object.defineProperty(es, 'onmessage', {
    get: () => _onmessage,
    set: (fn: any) => { _onmessage = fn; },
    enumerable: true,
  });
  Object.defineProperty(es, 'onerror', {
    get: () => _onerror,
    set: (fn: any) => { _onerror = fn; },
    enumerable: true,
  });
  es.close = mockClose;
  return es;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('useSSE', () => {
  let mockEs: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEs = createMockEventSource();
    (globalThis as any).EventSource = function(_url: string) { return mockEs; } as any;
    (globalThis as any).localStorage = {
      getItem: vi.fn(() => null),
    } as any;
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  async function sendMessage(event: object) {
    await waitFor(() => {
      expect(mockEs.onmessage).toBeTruthy();
    });
    mockEs.onmessage({ data: JSON.stringify(event) });
  }

  it('invalidates reviewers on task.review_assigned', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'task.review_assigned',
      data: { taskId: 't1', reviewerId: 'r1', reviewerType: 'human' },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['reviewers', 't1']) }),
    );
  });

  it('invalidates reviewers and task detail on task.review_completed', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'task.review_completed',
      data: { taskId: 't1', reviewerId: 'r1', status: 'approved' },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['reviewers', 't1']) }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['detail', 't1']) }),
    );
  });

  it('invalidates task detail and habitat on task.priority_changed', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'task.priority_changed',
      data: { taskId: 't1', ruleName: 'overdue', oldPriority: 'medium', newPriority: 'critical', score: 95 },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['detail', 't1']) }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['habitats', 'detail', 'b1']) }),
    );
  });

  it('invalidates sprint queries on sprint.created', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'sprint.created',
      data: { sprintId: 's1', habitatId: 'b1' },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'list', 'b1']) }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'active', 'b1']) }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'detail', 's1']) }),
    );
  });

  it('invalidates sprint queries on sprint.started', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'sprint.started',
      data: { sprintId: 's1', habitatId: 'b1' },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'list', 'b1']) }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'active', 'b1']) }),
    );
  });

  it('invalidates sprint queries on sprint.completed', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'sprint.completed',
      data: { sprintId: 's1', habitatId: 'b1', completedMissions: 5, carriedOver: 2 },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'list', 'b1']) }),
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['sprints', 'active', 'b1']) }),
    );
  });

  it('still handles existing task events after new cases added', async () => {
    renderHook(() => useSSE('b1'), { wrapper });

    await sendMessage({
      type: 'task.commented',
      data: { taskId: 't1', comment: { id: 'c1' } },
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['comments', 't1']) }),
    );
  });
});
