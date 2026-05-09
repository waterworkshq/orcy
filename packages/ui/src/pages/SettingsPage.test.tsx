import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage } from './SettingsPage.js';

const mockAuthMe = vi.fn();
const mockAuthChangePassword = vi.fn();
const mockAuthUpdateProfile = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../api/index.js', () => ({
  api: {
    auth: {
      me: (...args: any[]) => mockAuthMe(...args),
      changePassword: (...args: any[]) => mockAuthChangePassword(...args),
      updateProfile: (...args: any[]) => mockAuthUpdateProfile(...args),
    },
  },
}));

vi.mock('../lib/toast.js', () => ({
  notify: {
    success: (...args: any[]) => mockNotifySuccess(...args),
    error: (...args: any[]) => mockNotifyError(...args),
  },
}));

vi.mock('../components/ui/Button.js', () => ({
  Button: ({ children, onClick, type, disabled, loading, ...props }: any) => (
    <button type={type} onClick={onClick} disabled={disabled || loading} {...props}>
      {loading && <span data-testid="button-loading">Loading...</span>}
      {children}
    </button>
  ),
}));

vi.mock('../components/ui/Card.js', () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardTitle: ({ children, ...props }: any) => <h3 {...props}>{children}</h3>,
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  Loader2: ({ className }: any) => (
    <span data-testid="icon-loader" className={className}>
      ⟳
    </span>
  ),
  Settings: () => <span data-testid="icon-settings">⚙</span>,
  User: () => <span data-testid="icon-user">👤</span>,
  KeyRound: () => <span data-testid="icon-key">🔑</span>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/" element={<div>Home Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const defaultUser = {
  id: 'user-1',
  username: 'admin',
  role: 'admin',
  displayName: 'Admin User',
};

describe('SettingsPage', () => {
  beforeEach(() => {
    mockAuthMe.mockResolvedValue({ user: defaultUser });
    mockAuthChangePassword.mockResolvedValue({ success: true });
    mockAuthUpdateProfile.mockResolvedValue({ user: defaultUser });
  });

  afterEach(() => {
    cleanup();
    mockAuthMe.mockReset();
    mockAuthChangePassword.mockReset();
    mockAuthUpdateProfile.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
  });

  it('renders page with Settings heading', async () => {
    renderPage();

    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
  });

  it('shows Back navigation link to board list', async () => {
    renderPage();

    const backLink = screen.getByText('Back').closest('a');
    expect(backLink?.getAttribute('href')).toBe('/');
  });

  it('calls api.auth.me() on mount', async () => {
    renderPage();

    await waitFor(() => {
      expect(mockAuthMe).toHaveBeenCalledTimes(1);
    });
  });

  it('shows loading state while fetching user', () => {
    mockAuthMe.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByTestId('icon-loader')).toBeTruthy();
    expect(screen.getByText('Loading settings...')).toBeTruthy();
  });

  it('shows error state when api.auth.me() fails', async () => {
    mockAuthMe.mockRejectedValue(new Error('Network error'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('shows Change Password form with all three fields', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    expect(screen.getByText('Change Password', { selector: 'h3' })).toBeTruthy();
    expect(screen.getByLabelText('Current Password')).toBeTruthy();
    expect(screen.getByLabelText('New Password')).toBeTruthy();
    expect(screen.getByLabelText('Confirm New Password')).toBeTruthy();
    expect(screen.getByText('Change Password', { selector: 'button' })).toBeTruthy();
  });

  it('shows Display Name section with current value from api.auth.me()', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('display-name-section')).toBeTruthy();
    });

    expect(screen.getByText('Display Name')).toBeTruthy();
    expect(screen.getByTestId('current-display-name')).toBeTruthy();
    expect(screen.getByText('Admin User')).toBeTruthy();
  });

  it('falls back to username when displayName is empty', async () => {
    mockAuthMe.mockResolvedValue({
      user: { id: 'user-1', username: 'admin', role: 'admin', displayName: '' },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('admin')).toBeTruthy();
    });
  });

  it('validates new password minimum length', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'ab' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'ab' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByTestId('password-error')).toBeTruthy();
      expect(screen.getByTestId('password-error').textContent).toContain('at least 4 characters');
    });

    expect(mockAuthChangePassword).not.toHaveBeenCalled();
  });

  it('validates password confirmation match', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByTestId('password-error')).toBeTruthy();
      expect(screen.getByTestId('password-error').textContent).toContain('do not match');
    });

    expect(mockAuthChangePassword).not.toHaveBeenCalled();
  });

  it('does not submit when passwords do not match', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'old' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpass123' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpass456' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    expect(mockAuthChangePassword).not.toHaveBeenCalled();
  });

  it('calls api.auth.changePassword() with correct data on valid submit', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    await waitFor(() => {
      expect(mockAuthChangePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpass',
        newPassword: 'newpassword',
      });
    });
  });

  it('shows success message on successful password change', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByTestId('password-success')).toBeTruthy();
      expect(mockNotifySuccess).toHaveBeenCalledWith('Password changed successfully');
    });
  });

  it('shows error message on API error for password change', async () => {
    mockAuthChangePassword.mockRejectedValue(new Error('Current password is incorrect'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'wrongpass' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByTestId('password-error')).toBeTruthy();
      expect(screen.getByTestId('password-error').textContent).toContain('Current password is incorrect');
    });
  });

  it('clears password fields after successful change', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    const currentInput = screen.getByLabelText('Current Password') as HTMLInputElement;
    const newInput = screen.getByLabelText('New Password') as HTMLInputElement;
    const confirmInput = screen.getByLabelText('Confirm New Password') as HTMLInputElement;

    fireEvent.change(currentInput, { target: { value: 'oldpass' } });
    fireEvent.change(newInput, { target: { value: 'newpassword' } });
    fireEvent.change(confirmInput, { target: { value: 'newpassword' } });
    fireEvent.click(screen.getByText('Change Password', { selector: 'button' }));

    await waitFor(() => {
      expect(currentInput.value).toBe('');
      expect(newInput.value).toBe('');
      expect(confirmInput.value).toBe('');
    });
  });

  it('calls api.auth.updateProfile() on display name save', async () => {
    const updatedUser = { ...defaultUser, displayName: 'New Name' };
    mockAuthUpdateProfile.mockResolvedValue({ user: updatedUser });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('display-name-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('New Display Name'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save Display Name', { selector: 'button' }));

    await waitFor(() => {
      expect(mockAuthUpdateProfile).toHaveBeenCalledWith({ displayName: 'New Name' });
    });
  });

  it('updates displayed name after successful save', async () => {
    const updatedUser = { ...defaultUser, displayName: 'New Name' };
    mockAuthUpdateProfile.mockResolvedValue({ user: updatedUser });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('display-name-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('New Display Name'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save Display Name', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText('New Name')).toBeTruthy();
      expect(mockNotifySuccess).toHaveBeenCalledWith('Display name updated');
    });
  });

  it('shows error message on display name API error', async () => {
    mockAuthUpdateProfile.mockRejectedValue(new Error('Update failed'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('display-name-section')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('New Display Name'), { target: { value: 'Test' } });
    fireEvent.click(screen.getByText('Save Display Name', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByTestId('name-error')).toBeTruthy();
      expect(screen.getByTestId('name-error').textContent).toContain('Update failed');
    });
  });

  it('uses design-system classes (glass-card, btn-primary, etc.)', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-password-section')).toBeTruthy();
    });

    const settingsPage = screen.getByTestId('settings-page');
    expect(settingsPage.className).toContain('bg-surface');

    const passwordCard = screen.getByTestId('change-password-section');
    expect(passwordCard.className).toContain('glass-card');

    const nameCard = screen.getByTestId('display-name-section');
    expect(nameCard.className).toContain('glass-card');

    const header = settingsPage.querySelector('.glass-panel');
    expect(header).toBeTruthy();

    const headline = screen.getByText('Settings');
    expect(headline.className).toContain('font-headline');

    const buttons = screen.getAllByText(/Change Password|Save Display Name/);
    const submitButton = buttons.find((b) => b.tagName === 'BUTTON');
    expect(submitButton).toBeTruthy();
  });

  it('pre-populates display name input from api.auth.me()', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('display-name-section')).toBeTruthy();
    });

    const input = screen.getByLabelText('New Display Name') as HTMLInputElement;
    expect(input.value).toBe('Admin User');
  });
});
