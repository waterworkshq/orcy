import React, { useEffect, useState } from 'react';
import { api } from '../../api/index.js';
import { Button } from '../ui/Button.js';
import { notify } from '../../lib/toast.js';
import { Plus, Users, Trash2, Shield, UserPlus } from 'lucide-react';
import type { Organization, Team, TeamMember } from '../../types/index.js';

export function TeamsPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);

  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamSlug, setTeamSlug] = useState('');
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<'owner' | 'admin' | 'member'>('member');

  useEffect(() => {
    api.organizations.list()
      .then(setOrganizations)
      .catch((err) => console.warn('Failed to load organizations:', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedOrg) {
      api.organizations.listTeams(selectedOrg.id)
        .then(setTeams)
        .catch((err) => console.warn('Failed to load teams:', err));
    } else {
      setTeams([]);
    }
    setSelectedTeam(null);
    setMembers([]);
  }, [selectedOrg]);

  useEffect(() => {
    if (selectedTeam) {
      api.teams.listMembers(selectedTeam.id)
        .then(setMembers)
        .catch((err) => console.warn('Failed to load team members:', err));
    } else {
      setMembers([]);
    }
  }, [selectedTeam]);

  function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!orgName.trim()) return;
    try {
      const org = await api.organizations.create({ name: orgName.trim(), slug: orgSlug || slugify(orgName) });
      setOrganizations(prev => [...prev, org]);
      setSelectedOrg(org);
      setOrgName('');
      setOrgSlug('');
      setShowCreateOrg(false);
      notify.success(`Organization "${org.name}" created`);
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOrg || !teamName.trim()) return;
    try {
      const team = await api.organizations.createTeam(selectedOrg.id, {
        name: teamName.trim(),
        slug: teamSlug || slugify(teamName),
      });
      setTeams(prev => [...prev, team]);
      setTeamName('');
      setTeamSlug('');
      setShowCreateTeam(false);
      notify.success(`Team "${team.name}" created`);
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTeam || !memberUserId.trim()) return;
    try {
      const member = await api.teams.addMember(selectedTeam.id, {
        userId: memberUserId.trim(),
        role: memberRole,
      });
      setMembers(prev => [...prev, member]);
      setMemberUserId('');
      setMemberRole('member');
      setShowAddMember(false);
      notify.success('Member added');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!selectedTeam) return;
    try {
      await api.teams.removeMember(selectedTeam.id, userId);
      setMembers(prev => prev.filter(m => m.userId !== userId));
      notify.success('Member removed');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleDeleteTeam(teamId: string) {
    try {
      await api.teams.delete(teamId);
      setTeams(prev => prev.filter(t => t.id !== teamId));
      if (selectedTeam?.id === teamId) {
        setSelectedTeam(null);
        setMembers([]);
      }
      notify.success('Team deleted');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Teams</h1>
            <p className="text-muted-foreground mt-1">Manage organizations, teams, and memberships</p>
          </div>
          <Button onClick={() => setShowCreateOrg(true)}>
            <Plus className="h-4 w-4" />
            New Organization
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-1">
            <h2 className="mb-3 text-sm font-semibold uppercase text-muted-foreground">Organizations</h2>
            {organizations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No organizations yet.</p>
            ) : (
              <div className="space-y-1">
                {organizations.map(org => (
                  <button
                    key={org.id}
                    type="button"
                    onClick={() => setSelectedOrg(org)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      selectedOrg?.id === org.id
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {org.name}
                  </button>
                ))}
              </div>
            )}

            {selectedOrg && (
              <>
                <h2 className="mb-3 mt-6 text-sm font-semibold uppercase text-muted-foreground">Teams</h2>
                <div className="space-y-1">
                  {teams.map(team => (
                    <div key={team.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSelectedTeam(team)}
                        className={`flex-1 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                          selectedTeam?.id === team.id
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted'
                        }`}
                      >
                        {team.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTeam(team.id)}
                        className="rounded-md p-1 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowCreateTeam(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Team
                  </Button>
                </div>
              </>
            )}
          </div>

          <div className="col-span-2">
            {selectedTeam ? (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{selectedTeam.name}</h2>
                    <p className="text-xs text-muted-foreground">Slug: {selectedTeam.slug}</p>
                  </div>
                  <Button size="sm" onClick={() => setShowAddMember(true)}>
                    <UserPlus className="h-4 w-4" />
                    Add Member
                  </Button>
                </div>

                {members.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-8 text-center">
                    <Users className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No members yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {members.map(member => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between rounded-lg border bg-card p-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                            <Users className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div>
                            <p className="text-sm font-medium">{member.userId}</p>
                            <p className="text-xs text-muted-foreground">
                              Joined {new Date(member.joinedAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            member.role === 'owner' ? 'glass-badge glass-badge-medium' :
                            member.role === 'admin' ? 'glass-badge glass-badge-active' :
                            'glass-badge'
                          }`}>
                            {member.role === 'owner' && <Shield className="h-3 w-3" />}
                            {member.role}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(member.userId)}
                            className="rounded-md p-1 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-64 items-center justify-center rounded-lg border border-dashed">
                <p className="text-muted-foreground">Select a team to manage members</p>
              </div>
            )}
          </div>
        </div>

        {showCreateOrg && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
              <h2 className="mb-4 text-lg font-semibold">Create Organization</h2>
              <form onSubmit={handleCreateOrg}>
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Name</label>
                    <input
                      type="text"
                      value={orgName}
                      onChange={e => { setOrgName(e.target.value); setOrgSlug(slugify(e.target.value)); }}
                      placeholder="Acme Corp"
                      required
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Slug</label>
                    <input
                      type="text"
                      value={orgSlug}
                      onChange={e => setOrgSlug(e.target.value)}
                      placeholder="acme-corp"
                      required
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setShowCreateOrg(false)}>Cancel</Button>
                  <Button type="submit">Create</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showCreateTeam && selectedOrg && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
              <h2 className="mb-4 text-lg font-semibold">Create Team</h2>
              <form onSubmit={handleCreateTeam}>
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Name</label>
                    <input
                      type="text"
                      value={teamName}
                      onChange={e => { setTeamName(e.target.value); setTeamSlug(slugify(e.target.value)); }}
                      placeholder="Engineering"
                      required
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Slug</label>
                    <input
                      type="text"
                      value={teamSlug}
                      onChange={e => setTeamSlug(e.target.value)}
                      placeholder="engineering"
                      required
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setShowCreateTeam(false)}>Cancel</Button>
                  <Button type="submit">Create</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showAddMember && selectedTeam && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
              <h2 className="mb-4 text-lg font-semibold">Add Member</h2>
              <form onSubmit={handleAddMember}>
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">User ID</label>
                    <input
                      type="text"
                      value={memberUserId}
                      onChange={e => setMemberUserId(e.target.value)}
                      placeholder="User UUID"
                      required
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Role</label>
                    <select
                      value={memberRole}
                      onChange={e => setMemberRole(e.target.value as 'owner' | 'admin' | 'member')}
                      className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                  </div>
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setShowAddMember(false)}>Cancel</Button>
                  <Button type="submit">Add</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
