// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { AuthPage } from './AuthPage.js';

const mockSetupStatus = vi.hoisted(() => vi.fn());
const mockLogin = vi.hoisted(() => vi.fn());
const mockRegister = vi.hoisted(() => vi.fn());

vi.mock('../../api/index.js', () => ({
  api: {
    auth: {
      setupStatus: mockSetupStatus,
      login: mockLogin,
      register: mockRegister,
    },
  },
}));

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('AuthPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetupStatus.mockReset();
    mockLogin.mockReset();
    mockRegister.mockReset();
    mockNavigate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading state while setup-status API is in-flight', () => {
    mockSetupStatus.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    expect(screen.getByText('ORCY POD')).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders LoginForm when needsSetup is false', async () => {
    mockSetupStatus.mockResolvedValue({ needsSetup: false });
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('renders SetupForm when needsSetup is true', async () => {
    mockSetupStatus.mockResolvedValue({ needsSetup: true });
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create Account' })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument();
  });

  it('shows error state with retry button when setup-status API fails', async () => {
    mockSetupStatus.mockRejectedValue(new Error('Network error'));
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to check setup status. Please try again.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retry button re-calls setup-status', async () => {
    mockSetupStatus.mockRejectedValueOnce(new Error('Network error'));
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    mockSetupStatus.mockResolvedValue({ needsSetup: false });
    screen.getByRole('button', { name: 'Retry' }).click();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    });
    expect(mockSetupStatus).toHaveBeenCalledTimes(2);
  });

  it('shows ORCY POD branding with Orcy mark icon', async () => {
    mockSetupStatus.mockResolvedValue({ needsSetup: false });
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('ORCY POD')).toBeInTheDocument();
    });
    expect(document.querySelector('svg[aria-label="Orcy"]')).toBeInTheDocument();
  });

  it('renders in glass-card on bg-surface surface', async () => {
    mockSetupStatus.mockResolvedValue({ needsSetup: false });
    const { container } = render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('ORCY POD')).toBeInTheDocument();
    });

    expect(container.firstElementChild).toHaveClass('bg-surface', 'min-h-screen');
    expect(container.querySelector('.glass-card')).toBeInTheDocument();
  });
});
