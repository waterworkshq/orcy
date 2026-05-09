import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/index.js';
import { Button } from '../components/ui/Button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card.js';
import { notify } from '../lib/toast.js';
import { ArrowLeft, Loader2, Settings, User, KeyRound } from 'lucide-react';

const MIN_PASSWORD_LENGTH = 4;

export function SettingsPage() {
  const [currentUser, setCurrentUser] = useState<{
    id: string;
    username: string;
    role: string;
    displayName?: string;
  } | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [displayNameInput, setDisplayNameInput] = useState('');
  const [nameLoading, setNameLoading] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState(false);

  const fetchUser = useCallback(async () => {
    try {
      setLoadingUser(true);
      setUserError(null);
      const { user } = await api.auth.me();
      setCurrentUser(user);
      setDisplayNameInput(user.displayName ?? '');
    } catch (err) {
      setUserError((err as Error).message);
    } finally {
      setLoadingUser(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    setPasswordLoading(true);
    api.auth
      .changePassword({ currentPassword, newPassword })
      .then(() => {
        setPasswordSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        notify.success('Password changed successfully');
      })
      .catch((err) => {
        setPasswordError((err as Error).message);
      })
      .finally(() => setPasswordLoading(false));
  }

  function handleDisplayNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameSuccess(false);

    setNameLoading(true);
    api.auth
      .updateProfile({ displayName: displayNameInput })
      .then(({ user }) => {
        setCurrentUser(user);
        setNameSuccess(true);
        notify.success('Display name updated');
      })
      .catch((err) => {
        setNameError((err as Error).message);
      })
      .finally(() => setNameLoading(false));
  }

  return (
    <div data-testid="settings-page" className="min-h-screen bg-surface">
      <header className="glass-panel ghost-border-b sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-4">
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Settings className="h-6 w-6 text-primary" />
              <h1 className="font-headline text-xl font-bold text-on-surface">Settings</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {loadingUser && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-on-surface-variant font-body">Loading settings...</span>
          </div>
        )}

        {userError && (
          <Card className="bg-surface-container-high ghost-border">
            <CardContent className="py-12">
              <div className="text-center text-error font-body">{userError}</div>
            </CardContent>
          </Card>
        )}

        {!loadingUser && !userError && (
          <>
            <Card className="glass-card" data-testid="change-password-section">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-on-surface-variant" />
                  <CardTitle className="font-headline text-on-surface">Change Password</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="current-password" className="block text-sm font-body text-on-surface-variant mb-1">
                      Current Password
                    </label>
                    <input
                      id="current-password"
                      type="password"
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                      data-testid="current-password-input"
                    />
                  </div>

                  <div>
                    <label htmlFor="new-password" className="block text-sm font-body text-on-surface-variant mb-1">
                      New Password
                    </label>
                    <input
                      id="new-password"
                      type="password"
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                      data-testid="new-password-input"
                    />
                  </div>

                  <div>
                    <label htmlFor="confirm-password" className="block text-sm font-body text-on-surface-variant mb-1">
                      Confirm New Password
                    </label>
                    <input
                      id="confirm-password"
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                      data-testid="confirm-password-input"
                    />
                  </div>

                  {passwordError && (
                    <p className="text-sm text-error font-body" data-testid="password-error">
                      {passwordError}
                    </p>
                  )}

                  {passwordSuccess && (
                    <p className="text-sm text-[var(--badge-done)] font-body" data-testid="password-success">
                      Password changed successfully.
                    </p>
                  )}

                  <Button type="submit" disabled={passwordLoading} loading={passwordLoading}>
                    Change Password
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card className="glass-card" data-testid="display-name-section">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-on-surface-variant" />
                  <CardTitle className="font-headline text-on-surface">Display Name</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                {currentUser && (
                  <p className="text-sm text-on-surface-variant font-body mb-4" data-testid="current-display-name">
                    Current: <span className="text-on-surface">{currentUser.displayName || currentUser.username}</span>
                  </p>
                )}

                <form onSubmit={handleDisplayNameSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="display-name" className="block text-sm font-body text-on-surface-variant mb-1">
                      New Display Name
                    </label>
                    <input
                      id="display-name"
                      type="text"
                      value={displayNameInput}
                      onChange={(e) => setDisplayNameInput(e.target.value)}
                      className="ghost-border w-full rounded-md bg-surface-container-high px-3 py-2 font-body text-on-surface focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                      data-testid="display-name-input"
                    />
                  </div>

                  {nameError && (
                    <p className="text-sm text-error font-body" data-testid="name-error">
                      {nameError}
                    </p>
                  )}

                  {nameSuccess && (
                    <p className="text-sm text-[var(--badge-done)] font-body" data-testid="name-success">
                      Display name updated.
                    </p>
                  )}

                  <Button type="submit" disabled={nameLoading} loading={nameLoading}>
                    Save Display Name
                  </Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
