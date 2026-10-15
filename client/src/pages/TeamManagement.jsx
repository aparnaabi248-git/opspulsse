import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { teamsApi } from '../api';
import { useAsync, useNow } from '../hooks/useAsync';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/ui/ToastProvider';
import { Card, CardHead, Stat, Field } from '../components/ui/Primitives';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { formatRelative } from '../utils/format';

const ROLE_TONE = { owner: 'degraded', admin: 'pending', viewer: 'paused' };
const ROLE_HINT = {
  owner: 'Full control, including deleting the workspace and transferring ownership.',
  admin: 'Can add and remove monitors and members.',
  viewer: 'Read-only: can view monitors and incidents but not change them.',
};

export default function TeamManagement() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const now = useNow(30_000);

  const [activeId, setActiveId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteError, setInviteError] = useState(null);
  const [confirm, setConfirm] = useState(null); // { type, ... }
  const [newTeam, setNewTeam] = useState({ name: '', description: '' });

  const loadTeams = useCallback(() => teamsApi.list(), []);
  const { data: teamData, loading, error, reload: reloadTeams } = useAsync(loadTeams, [loadTeams]);
  const teams = teamData?.teams ?? [];
  const currentId = activeId ?? teams[0]?._id ?? null;

  const loadTeam = useCallback(
    () => (currentId ? teamsApi.get(currentId) : Promise.resolve(null)),
    [currentId]
  );
  const loadStats = useCallback(
    () => (currentId ? teamsApi.stats(currentId) : Promise.resolve(null)),
    [currentId]
  );

  const teamQ = useAsync(loadTeam, [loadTeam]);
  const statsQ = useAsync(loadStats, [loadStats]);

  const team = teamQ.data?.team;
  const members = teamQ.data?.members ?? [];
  const myRole = teamQ.data?.myRole ?? 'owner';
  const canManage = ['owner', 'admin'].includes(myRole);

  const invite = async (e) => {
    e.preventDefault();
    setInviteError(null);
    setBusy(true);
    try {
      const result = await teamsApi.addMember(currentId, { email: inviteEmail, role: inviteRole });
      toast.success(result.message);
      setInviteEmail('');
      teamQ.reload();
      statsQ.reload();
    } catch (err) {
      setInviteError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member, role) => {
    setBusy(true);
    try {
      const result = await teamsApi.updateMember(currentId, member.id, role);
      toast.success(`${member.name} is now ${result.role}.`);
      teamQ.reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    const action = confirm;
    setBusy(true);
    try {
      if (action.type === 'removeMember') {
        const result = await teamsApi.removeMember(currentId, action.member.id);
        toast.success(result.message || `${action.member.name} removed.`);
        teamQ.reload();
        statsQ.reload();
      } else if (action.type === 'transfer') {
        const result = await teamsApi.transferOwnership(currentId, action.member.id);
        toast.success(result.message);
        teamQ.reload();
        reloadTeams();
        refresh();
      } else if (action.type === 'deleteTeam') {
        await teamsApi.remove(currentId);
        toast.success(`Workspace "${action.name}" deleted.`);
        setActiveId(null);
        reloadTeams();
        refresh();
      } else if (action.type === 'leave') {
        const result = await teamsApi.leave(currentId);
        toast.success(result.message);
        setActiveId(null);
        reloadTeams();
        refresh();
      }
      setConfirm(null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const createTeam = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await teamsApi.create(newTeam);
      toast.success(`Workspace "${result.team.name}" created.`);
      setNewTeam({ name: '', description: '' });
      reloadTeams();
      refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !teamData) return <LoadingState label="Loading workspaces…" />;
  if (error) return <ErrorState error={error} onRetry={reloadTeams} />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="subtitle">
            Workspaces keep your monitors, incidents and members separate. Role:{' '}
            <strong>{myRole}</strong>
          </p>
        </div>
      </header>

      {teams.length > 1 && (
        <Card className="card-tight">
          <div className="toolbar">
            <label className="visually-hidden" htmlFor="manage-team">
              Workspace
            </label>
            <select
              id="manage-team"
              className="select"
              value={currentId ?? ''}
              onChange={(e) => setActiveId(e.target.value)}
            >
              {teams.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </Card>
      )}

      {statsQ.data && (
        <div className="grid grid-stats">
          <Stat label="Members" value={statsQ.data.members} tone="brand" />
          <Stat label="Monitors" value={statsQ.data.monitors} tone="brand" />
          <Stat label="Up" value={statsQ.data.monitorsByStatus.up} tone="up" />
          <Stat label="Down" value={statsQ.data.monitorsByStatus.down} tone="down" />
          <Stat
            label="Active incidents"
            value={statsQ.data.activeIncidents}
            tone={statsQ.data.activeIncidents ? 'down' : 'up'}
          />
        </div>
      )}

      <div className="grid grid-2">
        <Card>
          <CardHead
            title="Members"
            subtitle={`${members.length} in this workspace`}
            actions={
              canManage ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirm({ type: 'leave' })}
                >
                  Leave
                </button>
              ) : null
            }
          />

          {teamQ.loading && !teamQ.data ? (
            <LoadingState label="Loading members…" />
          ) : (
            <div className="stack-sm">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="row-between"
                  style={{
                    padding: 'var(--sp-3)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="cell-strong">
                      {member.name}
                      {member.id === user?.id && ' (you)'}
                    </div>
                    <div className="cell-sub">{member.email}</div>
                    <div className="timeline-time">
                      joined {formatRelative(member.joinedAt, now)}
                    </div>
                  </div>

                  <div className="row">
                    <span className={`badge ${ROLE_TONE[member.role]}`}>{member.role}</span>

                    {canManage && member.role !== 'owner' && (
                      <>
                        <label className="visually-hidden" htmlFor={`role-${member.id}`}>
                          Role for {member.name}
                        </label>
                        <select
                          id={`role-${member.id}`}
                          className="select"
                          style={{ width: 110 }}
                          value={member.role}
                          disabled={busy}
                          onChange={(e) => changeRole(member, e.target.value)}
                        >
                          <option value="viewer">viewer</option>
                          <option value="admin">admin</option>
                        </select>

                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--down)' }}
                          disabled={busy}
                          onClick={() => setConfirm({ type: 'removeMember', member })}
                          aria-label={`Remove ${member.name}`}
                        >
                          Remove
                        </button>

                        {myRole === 'owner' && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => setConfirm({ type: 'transfer', member })}
                          >
                            Make owner
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {canManage && (
            <form onSubmit={invite} className="stack-sm" style={{ marginTop: 'var(--sp-5)' }}>
              <h3 style={{ fontSize: 'var(--text-sm)' }}>Add a member</h3>
              <Field
                label="Email address"
                htmlFor="invite-email"
                error={inviteError}
                hint="The person must already have an OpsPulse account."
              >
                <input
                  id="invite-email"
                  type="email"
                  className="input"
                  value={inviteEmail}
                  onChange={(e) => {
                    setInviteEmail(e.target.value);
                    setInviteError(null);
                  }}
                  placeholder="colleague@example.com"
                />
              </Field>
              <div className="row">
                <label className="visually-hidden" htmlFor="invite-role">
                  Role
                </label>
                <select
                  id="invite-role"
                  className="select"
                  style={{ width: 130 }}
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                >
                  <option value="viewer">viewer</option>
                  <option value="admin">admin</option>
                </select>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Add member
                </button>
              </div>
              <p className="hint">{ROLE_HINT[inviteRole]}</p>
            </form>
          )}
        </Card>

        <div className="stack">
          <Card>
            <CardHead title="Workspace" subtitle={team?.description || 'No description'} />
            {team && (
              <div className="stack-sm">
                <div>
                  <div className="stat-label">Name</div>
                  <div className="cell-strong">{team.name}</div>
                </div>
                <div>
                  <div className="stat-label">Created</div>
                  <div className="cell-sub">{new Date(team.createdAt).toLocaleString()}</div>
                </div>
                <div>
                  <div className="stat-label">Your role</div>
                  <div className="hint">{ROLE_HINT[myRole]}</div>
                </div>

                {canManage && (
                  <Link to="/app/monitors" className="btn btn-secondary">
                    Manage monitors in this workspace →
                  </Link>
                )}

                {myRole === 'owner' && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => setConfirm({ type: 'deleteTeam', name: team.name })}
                    disabled={busy}
                  >
                    Delete this workspace
                  </button>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Create a workspace" subtitle="Useful for separating clients or environments" />
            <form onSubmit={createTeam} className="stack-sm">
              <Field label="Name" htmlFor="new-team-name" required>
                <input
                  id="new-team-name"
                  className="input"
                  value={newTeam.name}
                  onChange={(e) => setNewTeam((t) => ({ ...t, name: e.target.value }))}
                  placeholder="Client X — Production"
                  minLength={2}
                  required
                />
              </Field>
              <Field label="Description (optional)" htmlFor="new-team-description">
                <input
                  id="new-team-description"
                  className="input"
                  value={newTeam.description}
                  onChange={(e) => setNewTeam((t) => ({ ...t, description: e.target.value }))}
                  placeholder="Everything we monitor for Client X"
                  maxLength={500}
                />
              </Field>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Create workspace
              </button>
            </form>
          </Card>
        </div>
      </div>

      {teams.length === 0 && (
        <Card>
          <EmptyState
            icon="⌂"
            title="No workspaces"
            message="Create one to start adding monitors."
          />
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={
          confirm?.type === 'removeMember'
            ? `Remove ${confirm.member.name}?`
            : confirm?.type === 'transfer'
              ? `Make ${confirm.member.name} the owner?`
              : confirm?.type === 'deleteTeam'
                ? `Delete "${confirm.name}"?`
                : 'Leave this workspace?'
        }
        message={
          confirm?.type === 'removeMember'
            ? 'They will lose access to this workspace immediately.'
            : confirm?.type === 'transfer'
              ? 'They become the owner and you become an admin. Only do this with someone you trust.'
              : confirm?.type === 'deleteTeam'
                ? 'Every monitor, incident and member in this workspace is removed. This cannot be undone.'
                : 'You will lose access to this workspace.'
        }
        confirmLabel="Confirm"
        busy={busy}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}