import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/index.js';
import { Button } from '../components/ui/Button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card.js';
import { notify } from '../lib/toast.js';
import { ArrowLeft, Loader2, Settings, User, KeyRound } from 'lucide-react';
import { useUserProfile } from '../lib/useHabitatData.js';
import { queryKeys } from '../lib/queryKeys.js';

const MIN_PASSWORD_LENGTH = 4;

export function SettingsPage() {
  const { data: profileData, isLoading: loadingUser, error: userErrorObj } = useUserProfile();
  const currentUser = profileData?.user ?? null;
  const userError = userErrorObj ? (userErrorObj as Error).message : null;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [displayNameInput, setDisplayNameInput] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState(false);

  const qc = useQueryClient();

  const displayNameSynced = React.useRef(false);
  React.useEffect(() => {
    if (currentUser && !displayNameSynced.current) {
      setDisplayNameInput(currentUser.displayName ?? '');
      displayNameSynced.current = true;
    }
  }, [currentUser]);

  const changePasswordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      api.auth.changePassword(data),
    onSuccess: () => {
      setPasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      notify.success('Password changed successfully');
    },
    onError: (err: Error) => {
      setPasswordError(err.message);
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: (data: { displayName: string }) =>
      api.auth.updateProfile(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.user.profile() });
      setNameSuccess(true);
      notify.success('Display name updated');
    },
    onError: (err: Error) => {
      setNameError(err.message);
    },
  });

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

    changePasswordMutation.mutate({ currentPassword, newPassword });
  }

  function handleDisplayNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameSuccess(false);
    updateProfileMutation.mutate({ displayName: displayNameInput });
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

                  <Button type="submit" disabled={changePasswordMutation.isPending} loading={changePasswordMutation.isPending}>
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

                  <Button type="submit" disabled={updateProfileMutation.isPending} loading={updateProfileMutation.isPending}>
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
