import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useTemplates,
  useChatIntegrations,
  useNotificationPrefs,
  useScheduledTasks,
  useArchivedFeatures,
} from './useHabitatData.js';

vi.mock('../api/index.js', () => ({
  api: {
    templates: {
      list: vi.fn().mockResolvedValue({ templates: [{ id: 't1', name: 'Template 1' }] }),
    },
    chatIntegrations: {
      list: vi.fn().mockResolvedValue([{ id: 'ci1', provider: 'slack' }]),
    },
    notifications: {
      getGlobalPrefs: vi.fn().mockResolvedValue({ preferences: { email: true }, email: 'a@b.c' }),
      getBoardPrefs: vi.fn().mockResolvedValue({ preferences: { slack: true } }),
    },
    scheduledTasks: {
      list: vi.fn().mockResolvedValue({ scheduledTasks: [{ id: 'st1', name: 'Daily' }] }),
    },
    features: {
      list: vi.fn().mockResolvedValue({ features: [{ id: 'f1', title: 'Archived' }], total: 1 }),
    },
  },
}));

import { api } from '../api/index.js';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTemplates', () => {
  it('fetches data when boardId is provided', async () => {
    const { result } = renderHook(() => useTemplates('board-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.templates.list).toHaveBeenCalledWith('board-1');
    expect(result.current.data).toEqual({ templates: [{ id: 't1', name: 'Template 1' }] });
  });

  it('is disabled when boardId is undefined', () => {
    const { result } = renderHook(() => useTemplates(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.templates.list).not.toHaveBeenCalled();
  });
});

describe('useChatIntegrations', () => {
  it('fetches data when boardId is provided', async () => {
    const { result } = renderHook(() => useChatIntegrations('board-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.chatIntegrations.list).toHaveBeenCalledWith('board-1');
    expect(result.current.data).toEqual([{ id: 'ci1', provider: 'slack' }]);
  });

  it('is disabled when boardId is undefined', () => {
    const { result } = renderHook(() => useChatIntegrations(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.chatIntegrations.list).not.toHaveBeenCalled();
  });
});

describe('useNotificationPrefs', () => {
  it('fetches global and board prefs in parallel', async () => {
    const { result } = renderHook(() => useNotificationPrefs('board-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.notifications.getGlobalPrefs).toHaveBeenCalled();
    expect(api.notifications.getBoardPrefs).toHaveBeenCalledWith('board-1');
    expect(result.current.data).toEqual({
      global: { preferences: { email: true }, email: 'a@b.c' },
      board: { preferences: { slack: true } },
    });
  });

  it('is disabled when boardId is undefined', () => {
    const { result } = renderHook(() => useNotificationPrefs(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.notifications.getGlobalPrefs).not.toHaveBeenCalled();
    expect(api.notifications.getBoardPrefs).not.toHaveBeenCalled();
  });
});

describe('useScheduledTasks', () => {
  it('fetches data when boardId is provided', async () => {
    const { result } = renderHook(() => useScheduledTasks('board-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.scheduledTasks.list).toHaveBeenCalledWith('board-1');
    expect(result.current.data).toEqual({ scheduledTasks: [{ id: 'st1', name: 'Daily' }] });
  });

  it('is disabled when boardId is undefined', () => {
    const { result } = renderHook(() => useScheduledTasks(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.scheduledTasks.list).not.toHaveBeenCalled();
  });
});

describe('useArchivedFeatures', () => {
  it('passes { isArchived: true } to api.features.list', async () => {
    const { result } = renderHook(() => useArchivedFeatures('board-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.features.list).toHaveBeenCalledWith('board-1', { isArchived: true });
    expect(result.current.data).toEqual({ features: [{ id: 'f1', title: 'Archived' }], total: 1 });
  });

  it('is disabled when boardId is undefined', () => {
    const { result } = renderHook(() => useArchivedFeatures(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.features.list).not.toHaveBeenCalled();
  });
});
