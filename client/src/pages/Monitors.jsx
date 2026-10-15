import { useCallback, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { monitorsApi } from '../api';
import { useAsync, useDebouncedValue, useNow } from '../hooks/useAsync';
import { useActiveTeam } from '../context/AuthContext';
import { useToast } from '../components/ui/ToastProvider';
import { Card, Pagination, Alert } from '../components/ui/Primitives';
import StatusBadge from '../components/ui/StatusBadge';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { formatMs, formatRelative, truncateUrl } from '../utils/format';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'paused', label: 'Paused' },
  { value: 'pending', label: 'Pending' },
];

export default function Monitors() {
  const { teamId, canManage } = useActiveTeam();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow(20_000);

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const search = useDebouncedValue(searchInput, 350);

  const page = Number(searchParams.get('page') ?? 1);
  const status = searchParams.get('status') ?? 'all';

  const [busyId, setBusyId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [actionError, setActionError] = useState(null);

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(
    () =>
      monitorsApi.list({
        teamId,
        status,
        search: search || undefined,
        page,
        limit: 20,
      }),
    [teamId, status, search, page]
  );

  const { data, loading, error, reload, setData } = useAsync(load, [load]);
  const monitors = data?.monitors ?? [];

  const patchMonitor = (id, patch) => {
    setData((current) =>
      current
        ? { ...current, monitors: current.monitors.map((m) => (m.id === id ? { ...m, ...patch } : m)) }
        : current
    );
  };

  const runCheck = async (monitor) => {
    setBusyId(monitor.id);
    setActionError(null);
    try {
      const result = await monitorsApi.runCheck(monitor.id);
      patchMonitor(monitor.id, result.monitor);
      const label = result.status.toUpperCase();
      if (result.status === 'up') toast.success(`${monitor.name} is ${label} (${formatMs(result.responseTimeMs)})`);
      else if (result.status === 'degraded') toast.info(`${monitor.name} is DEGRADED — ${result.errorMessage ?? 'slow response'}`);
      else toast.error(`${monitor.name} is ${label} — ${result.errorMessage ?? 'check failed'}`);
      reload();
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const togglePause = async (monitor) => {
    setBusyId(monitor.id);
    setActionError(null);
    try {
      const result = monitor.isPaused
        ? await monitorsApi.resume(monitor.id)
        : await monitorsApi.pause(monitor.id);
      patchMonitor(monitor.id, result.monitor);
      toast.success(result.message);
    } catch (err) {
      setActionError(err.message);
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const monitor = pendingDelete;
    setBusyId(monitor.id);
    try {
      const result = await monitorsApi.remove(monitor.id);
      toast.success(result ? `Deleted "${monitor.name}" and its check history.` : 'Monitor deleted.');
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Monitors</h1>
          <p className="subtitle">
            {loading ? 'Loading…' : `${monitors.length} shown · page ${data?.pagination?.page ?? 1}`}
          </p>
        </div>
        <Link to="/app/monitors/new" className="btn btn-primary">
          + Add monitor
        </Link>
      </header>

      {actionError && <Alert type="error">{actionError}</Alert>}

      <Card className="card-tight">
        <div className="toolbar">
          <div className="grow">
            <label className="visually-hidden" htmlFor="monitor-search">
              Search monitors
            </label>
            <input
              id="monitor-search"
              className="input"
              style={{ width: '100%' }}
              placeholder="Search by name or URL…"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setParam('search', e.target.value);
              }}
            />
          </div>

          <div className="chip-row" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={`chip${status === filter.value ? ' active' : ''}`}
                onClick={() => setParam('status', filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {loading && !data ? (
        <LoadingState label="Loading monitors…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : monitors.length === 0 ? (
        <Card>
          <EmptyState
            icon="◉"
            title={search || status !== 'all' ? 'No monitors match your filters' : 'No monitors yet'}
            message={
              search || status !== 'all'
                ? 'Try clearing the search box or choosing a different status.'
                : 'Add a website or API endpoint and OpsPulse will check it on your chosen interval.'
            }
            actionLabel={search || status !== 'all' ? 'Clear filters' : 'Add your first monitor'}
            onAction={
              search || status !== 'all'
                ? () => {
                    setSearchInput('');
                    setSearchParams({}, { replace: true });
                  }
                : undefined
            }
            actionTo={!search && status === 'all' ? '/app/monitors/new' : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Monitor</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last response</th>
                  <th scope="col">Interval</th>
                  <th scope="col">Last checked</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {monitors.map((monitor) => {
                  const busy = busyId === monitor.id;
                  return (
                    <tr key={monitor.id}>
                      <td>
                        <Link to={`/app/monitors/${monitor.id}`} className="cell-strong">
                          {monitor.name}
                        </Link>
                        <div className="cell-sub">{truncateUrl(monitor.url, 56)}</div>
                      </td>
                      <td>
                        <StatusBadge
                          status={monitor.status}
                          pulse={monitor.status === 'down' || monitor.status === 'degraded'}
                        />
                        {monitor.isRecovering && monitor.recoveryProgress && (
                          <div className="cell-sub" style={{ marginTop: 4 }}>
                            recovering {monitor.recoveryProgress.done}/{monitor.recoveryProgress.needed}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="num">{formatMs(monitor.lastResponseTimeMs)}</div>
                        <div className="cell-sub">
                          {monitor.lastStatusCode ? `HTTP ${monitor.lastStatusCode}` : monitor.lastError || '—'}
                        </div>
                      </td>
                      <td className="num">{monitor.intervalSeconds}s</td>
                      <td className="num" title={monitor.lastCheckAt ?? ''}>
                        {monitor.isPaused ? (
                          <span className="cell-sub">paused</span>
                        ) : (
                          formatRelative(monitor.lastCheckAt, now)
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => runCheck(monitor)}
                            disabled={busy || monitor.isPaused}
                            title={monitor.isPaused ? 'Resume the monitor first' : 'Run a check now'}
                          >
                            {busy ? <span className="spinner" aria-hidden="true" /> : 'Check'}
                          </button>
                          {canManage && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => togglePause(monitor)}
                              disabled={busy}
                            >
                              {monitor.isPaused ? 'Resume' : 'Pause'}
                            </button>
                          )}
                          <Link
                            to={`/app/monitors/${monitor.id}`}
                            className="btn btn-ghost btn-sm"
                            aria-label={`Open ${monitor.name}`}
                          >
                            Open
                          </Link>
                          {canManage && (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => navigate(`/app/monitors/${monitor.id}/edit`)}
                                disabled={busy}
                                aria-label={`Edit ${monitor.name}`}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{ color: 'var(--down)' }}
                                onClick={() => setPendingDelete(monitor)}
                                disabled={busy}
                                aria-label={`Delete ${monitor.name}`}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination meta={data.pagination} onChange={(p) => setParam('page', String(p))} />
        </>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`Delete "${pendingDelete?.name}"?`}
        message="This permanently removes the monitor and every check result stored for it. This cannot be undone."
        confirmLabel="Delete monitor"
        busy={Boolean(pendingDelete) && busyId === pendingDelete?.id}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}