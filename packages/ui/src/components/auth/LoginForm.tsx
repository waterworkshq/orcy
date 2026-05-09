import React, { useState, FormEvent } from 'react';

export interface LoginFormProps {
  onSubmit: (username: string, password: string) => Promise<void>;
  error: string | null;
}

export function LoginForm({ onSubmit, error }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(username, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
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
          disabled={submitting}
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
          disabled={submitting}
        />
      </div>
      <button
        type="submit"
        className="btn-primary w-full py-2 px-4 font-body"
        disabled={submitting}
      >
        Sign In
      </button>
    </form>
  );
}
