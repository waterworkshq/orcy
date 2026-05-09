import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useHabitatSettingsSaver } from './useHabitatSettingsSaver.js';

const mockUpdate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../api/index.js', () => ({
  api: {
    boards: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

describe('useHabitatSettingsSaver', () => {
  const mockOnUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ board: { id: 'b1', name: 'Test' } });
  });

  it('starts with saving=false', () => {
    const { result } = renderHook(() => useHabitatSettingsSaver({
      habitatId: 'b1',
      onUpdate: mockOnUpdate,
    }));
    expect(result.current.saving).toBe(false);
  });

  it('calls API and manages saving state', async () => {
    const { result } = renderHook(() => useHabitatSettingsSaver({
      habitatId: 'b1',
      onUpdate: mockOnUpdate,
    }));

    await act(async () => {
      await result.current.saveSettings({ name: 'New Name' }, 'Saved!');
    });

    expect(mockUpdate).toHaveBeenCalledWith('b1', { name: 'New Name' });
    expect(mockOnUpdate).toHaveBeenCalledWith({ id: 'b1', name: 'Test' });
    expect(mockNotifySuccess).toHaveBeenCalledWith('Saved!');
    expect(result.current.saving).toBe(false);
  });

  it('shows error notification on failure', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('API error'));

    const { result } = renderHook(() => useHabitatSettingsSaver({
      habitatId: 'b1',
      onUpdate: mockOnUpdate,
    }));

    await act(async () => {
      await result.current.saveSettings({ name: 'Fail' }, 'Should not show');
    });

    expect(result.current.saving).toBe(false);
    expect(mockNotifyError).toHaveBeenCalledWith('API error');
    expect(mockNotifySuccess).not.toHaveBeenCalled();
  });
});
