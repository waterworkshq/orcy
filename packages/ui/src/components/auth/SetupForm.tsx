import React, { useState, FormEvent } from 'react';

export interface SetupFormProps {
  onSubmit: (username: string, password: string, displayName?: string) => Promise<void>;
  error: string | null;
}

export function SetupForm({ onSubmit, error }: SetupFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mismatchError, setMismatchError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMismatchError('');

    if (password !== confirmPassword) {
      setMismatchError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(username, password, displayName || undefined);
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
      {mismatchError && (
        <div className="mb-4 rounded-md bg-error-container/30 p-3 text-sm text-error ghost-border">
          {mismatchError}
        </div>
      )}
      <div className="mb-4">
        <label htmlFor="setup-username" className="mb-2 block font-body text-sm font-medium text-on-surface-variant">Username</label>
        <input
          id="setup-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface placeholder:text-on-surface-variant focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          required
          disabled={submitting}
        />
      </div>
      <div className="mb-4">
        <label htmlFor="setup-password" className="mb-2 block font-body text-sm font-medium text-on-surface-variant">Password</label>
        <input
          id="setup-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface placeholder:text-on-surface-variant focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          required
          disabled={submitting}
        />
      </div>
      <div className="mb-4">
        <label htmlFor="setup-confirm-password" className="mb-2 block font-body text-sm font-medium text-on-surface-variant">Confirm Password</label>
        <input
          id="setup-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface placeholder:text-on-surface-variant focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          required
          disabled={submitting}
        />
      </div>
      <div className="mb-6">
        <label htmlFor="setup-display-name" className="mb-2 block font-body text-sm font-medium text-on-surface-variant">Display Name <span className="text-on-surface-variant/60">(optional)</span></label>
        <input
          id="setup-display-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface placeholder:text-on-surface-variant focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          disabled={submitting}
        />
      </div>
      <button
        type="submit"
        className="btn-primary w-full py-2 px-4 font-body"
        disabled={submitting}
      >
        Create Account
      </button>
    </form>
  );
}
