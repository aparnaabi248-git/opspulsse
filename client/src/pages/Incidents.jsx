import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { incidentsApi } from '../api';
import { useAsync, useDebouncedValue, useNow } from '../hooks/useAsync';
import { useActiveTeam } from '../context/AuthContext';
import { useLiveRefresh } from '../context/RealtimeContext';
import { Card, Pagination, Alert, Stat } from '../components/ui/Primitives';
import DataNote from '../components/ui/DataNote';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { formatDateTime, formatDuration, formatRelative } from '../utils/format';
import { CHART_COLORS } from '../utils/status';

const STATUS_FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
];

const SEVERITY_TONE = {
  critical: 'down',
  warning: 'degraded',
  info: 'paused',
};

export default function Incidents() {
  const { teamId } = useActiveTeam();
  const now = useNow(20_000);

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const search = useDebouncedValue(searchInput, 350);

  const page = Number(searchParams.get('page') ?? 1);
  const status = searchParams.get('status') ?? 'active';
  const severity = searchParams.get('severity') ?? 'all';

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    // Only an empty value removes the parameter. "all" is a real choice and
    // must be written explicitly, otherwise removing it would silently fall
    // back to the "active" default.
    if (!value) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(
    () =>
      incidentsApi.list({
        teamId,
        status,
        severity,
        search: search || undefined,
        page,
        limit: 20,
      }),
    [teamId, status, severity, search, page]
  );

  const { data, loading, error, reload } = useAsync(load, [load]);
  const incidents = data?.incidents ?? [];

  // A monitor going down or recovering changes this list without a refresh
  useLiveRefresh(reload, ['monitor:status', 'incident:created', 'incident:updated', 'incident:resolved']);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="subtitle">
            One incident per outage. Opened automatically after repeated failures, closed when the
            monitor recovers.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Refresh
        </button>
      </header>

      <div className="grid grid-stats">
        {['open', 'acknowledged', 'resolved'].map((key) => (
          <Stat
            key={key}
            label={key[0].toUpperCase() + key.slice(1)}
            value={
              loading && !data
                ? '…'
                : incidents.filter((i) => i.status === key).length
            }
            tone={SEVERITY_TONE[key === 'open' ? 'critical' : key === 'acknowledged' ? 'warning' : 'info']}
          />
        ))}
      </div>

      <Card className="card-tight">
        <div className="toolbar">
          <div className="grow">
            <label className="visually-hidden" htmlFor="incident-search">
              Search incidents
            </label>
            <input
              id="incident-search"
              className="input"
              style={{ width: '100%' }}
              placeholder="Search incidents…"
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

          <label className="visually-hidden" htmlFor="incident-severity">
            Severity
          </label>
          <select
            id="incident-severity"
            className="select"
            value={severity}
            onChange={(e) => setParam('severity', e.target.value)}
          >
            <option value="all">Any severity</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </Card>

      {loading && !data ? (
        <LoadingState label="Loading incidents…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : incidents.length === 0 ? (
        <Card>
          <EmptyState
            icon={status === 'active' ? '✓' : '◷'}
            title={status === 'active' ? 'No active incidents' : 'No incidents found'}
            message={
              status === 'active'
                ? 'Nothing is on fire right now. Incidents appear here automatically when a monitor fails repeatedly.'
                : 'Try a different filter, or wait for a monitor to fail.'
            }
            actionLabel={status !== 'active' ? 'Show active only' : undefined}
            onAction={status !== 'active' ? () => setParam('status', 'active') : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Incident</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr key={incident._id}>
                    <td>
                      <Link to={`/app/incidents/${incident._id}`} className="cell-strong">
                        {incident.title}
                      </Link>
                      <div className="cell-sub">
                        {incident.monitor?.name ?? 'Monitor deleted'}
                        {incident.monitor?.status ? ` · ${incident.monitor.status}` : ''}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${SEVERITY_TONE[incident.severity] ?? 'paused'}`}>
                        <span
                          className="dot"
                          style={{ background: CHART_COLORS[incident.severity] ?? CHART_COLORS.paused }}
                          aria-hidden="true"
                        />
                        {incident.severity}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${incident.status === 'resolved' ? 'paused' : 'down'}`}>
                        {incident.status}
                      </span>
                    </td>
                    <td className="num">{incident.failureCount}</td>
                    <td className="num">{formatDuration(incident.durationMs)}</td>
                    <td className="num" title={formatDateTime(incident.startedAt)}>
                      {formatRelative(incident.startedAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination meta={data.pagination} onChange={(p) => setParam('page', String(p))} />
        </>
      )}

      <DataNote title="How incidents work:">
        One incident is created per outage, after a monitor fails its configured failure threshold
        in a row. While it stays down the open incident is updated rather than duplicated, and it
        closes automatically when the monitor recovers.
      </DataNote>
    </div>
  );
}