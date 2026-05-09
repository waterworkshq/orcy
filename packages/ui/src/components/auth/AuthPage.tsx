import React, { useState, useEffect, useCallback } from 'react';
import { OrcyMark } from '../ui/icons/OrcyMark.js';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/index.js';
import { LoginForm } from './LoginForm.js';
import { SetupForm } from './SetupForm.js';

type AuthState = 'loading' | 'error' | 'ready';

export function AuthPage() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const navigate = useNavigate();

  const checkSetupStatus = useCallback(async () => {
    setAuthState('loading');
    setFormError(null);
    try {
      const result = await api.auth.setupStatus();
      setNeedsSetup(result.needsSetup);
      setAuthState('ready');
    } catch {
      setAuthState('error');
    }
  }, []);

  useEffect(() => {
    checkSetupStatus();
  }, [checkSetupStatus]);

  async function handleLogin(username: string, password: string) {
    setFormError(null);
    try {
      const result = await api.auth.login({ username, password });
      localStorage.setItem('orcy_token', result.token);
      navigate('/');
    } catch (err) {
      setFormError((err as Error).message || 'Invalid credentials');
    }
  }

  async function handleRegister(username: string, password: string, displayName?: string) {
    setFormError(null);
    try {
      const result = await api.auth.register({ username, password, displayName });
      localStorage.setItem('orcy_token', result.token);
      navigate('/');
    } catch (err) {
      setFormError((err as Error).message || 'Registration failed');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 font-body text-on-surface">
      <div className="glass-card w-full max-w-sm p-8 shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded bg-primary-container text-on-surface shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
            <OrcyMark size={20} />
          </div>
          <div>
            <p className="text-xs font-body font-semibold uppercase tracking-[0.24em] text-on-surface-variant">
              ORCY POD
            </p>
            {authState === 'ready' && !needsSetup && (
              <h1 className="mt-2 font-headline text-2xl font-bold tracking-tight text-on-surface">
                Sign In
              </h1>
            )}
            {authState === 'ready' && needsSetup && (
              <h1 className="mt-2 font-headline text-2xl font-bold tracking-tight text-on-surface">
                Create Account
              </h1>
            )}
          </div>
        </div>

        {authState === 'loading' && (
          <div className="flex items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          </div>
        )}

        {authState === 'error' && (
          <div className="text-center">
            <p className="mb-4 text-sm text-on-surface-variant">Failed to check setup status. Please try again.</p>
            <button
              onClick={checkSetupStatus}
              className="btn-primary py-2 px-4 font-body"
            >
              Retry
            </button>
          </div>
        )}

        {authState === 'ready' && needsSetup && (
          <SetupForm onSubmit={handleRegister} error={formError} />
        )}

        {authState === 'ready' && !needsSetup && (
          <LoginForm onSubmit={handleLogin} error={formError} />
        )}
      </div>
    </div>
  );
}
