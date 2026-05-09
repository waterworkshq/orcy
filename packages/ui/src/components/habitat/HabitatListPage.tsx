import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/index.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { OnboardingModal } from '../ui/OnboardingModal.js';
import { notify } from '../../lib/toast.js';
import { Plus, LayoutGrid, Users } from 'lucide-react';
import type { Board, Team } from '../../types/index.js';
import { useBoards, useMyTeams, useInvalidateBoards } from '../../lib/useHabitatData.js';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys.js';

export function BoardListPage() {
  const { data: boardsData, isLoading: loading } = useBoards();
  const { data: teamsData } = useMyTeams();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newTeamId, setNewTeamId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const boards = boardsData ?? [];
  const teams = teamsData ?? [];

  useEffect(() => {
    if (boards.length === 0 && localStorage.getItem('orcy_onboarding_completed') !== 'true') {
      setShowOnboarding(true);
    }
  }, [boards.length]);

  function handleOnboardingComplete() {
    localStorage.setItem('orcy_onboarding_completed', 'true');
    setShowOnboarding(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.boards.create({
        name: newName.trim(),
        description: newDesc.trim(),
        teamId: newTeamId || null,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.boards.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.teams.myTeams() });
      setNewName('');
      setNewDesc('');
      setNewTeamId('');
      setShowCreate(false);
      notify.success(`Habitat "${newName.trim()}" created`);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 md:mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">Orcy</h1>
            <p className="text-sm md:text-base text-muted-foreground mt-1">
              Task orchestration for AI agents
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/teams">
              <Button variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Users className="h-4 w-4" />
                Teams
              </Button>
            </Link>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Habitat</span>
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : boards.length === 0 ? (
          <Card className="py-12 text-center">
            <CardContent>
              <LayoutGrid className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
              <p className="mb-4 text-muted-foreground">No habitats yet. Create your first habitat.</p>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                Create Habitat
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <Link key={board.id} to={`/boards/${board.id}`}>
                <Card className="cursor-pointer transition-shadow hover:shadow-lg">
                  <CardHeader className="p-4">
                    <CardTitle className="text-base">{board.name}</CardTitle>
                    {board.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {board.description}
                      </p>
                    )}
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(board.createdAt).toLocaleDateString()}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-t-xl md:rounded-lg bg-background p-6 shadow-lg mobile-dialog-full">
              <h2 className="mb-4 text-lg font-semibold">Create Habitat</h2>
              <form onSubmit={handleCreate}>
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Name</label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Sprint 24"
                      required
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Description</label>
                    <textarea
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder="Optional description"
                      rows={3}
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  {teams.length > 0 && (
                    <div>
                      <label className="mb-1 block text-sm font-medium">Team</label>
                      <select
                        value={newTeamId}
                        onChange={e => setNewTeamId(e.target.value)}
                        className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        <option value="">No team</option>
                        {teams.map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" loading={creating}>
                    Create
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        <OnboardingModal isOpen={showOnboarding} onComplete={handleOnboardingComplete} />
      </div>
    </div>
  );
}
