import React, { useState, FormEvent } from 'react';
import { OrcyMark } from '../ui/icons/OrcyMark.js';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/index.js';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const result = await api.auth.login({ username, password });
      localStorage.setItem('orcy_token', result.token);
      navigate('/');
    } catch (err) {
      setError((err as Error).message || 'Invalid credentials');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 font-body text-on-surface">
      <form
        onSubmit={handleLogin}
        className="glass-card w-full max-w-sm p-8 shadow-[0_4px_20px_rgba(0,0,0,0.3)]"
      >
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded bg-primary-container text-on-surface shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
            <OrcyMark size={20} />
          </div>
          <div>
            <p className="text-xs font-body font-semibold uppercase tracking-[0.24em] text-on-surface-variant">
              ORCY POD
            </p>
            <h1 className="mt-2 font-headline text-2xl font-bold tracking-tight text-on-surface">
              Sign In
            </h1>
          </div>
        </div>
        {error && (
          <div className="mb-4 rounded-md bg-error-container/30 p-3 text-sm text-error ghost-border">
            {error}
          </div>
        )}
        <div className="mb-4">
          <label htmlFor="username" className="mb-2 block font-body text-sm font-medium text-on-surface-variant">Username</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface placeholder:text-on-surface-variant focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            required
          />
        </div>
        <div className="mb-6">
          <label htmlFor="password" className="mb-2 block font-body text-sm font-medium text-on-surface-variant">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface placeholder:text-on-surface-variant focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            required
          />
        </div>
        <button
          type="submit"
          className="btn-primary w-full py-2 px-4 font-body"
        >
          Sign In
        </button>
      </form>
    </div>
  );
}
