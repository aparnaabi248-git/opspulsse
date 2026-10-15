import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { analyticsApi, checksApi, incidentsApi } from '../api';
import { useAsync, useNow } from '../hooks/useAsync';
import { useActiveTeam } from '../context/AuthContext';
import { useLiveRefresh, useRealtime } from '../context/RealtimeContext';
import { Card, CardHead, Stat, Alert } from '../components/ui/Primitives';
import DataNote from '../components/ui/DataNote';
import StatusBadge from '../components/ui/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { ResponseTimeChart, UptimeChart, StatusDonut } from '../components/charts/Charts';
import { RANGE_OPTIONS } from '../utils/status';
import { formatMs, formatNumber, formatRelative } from '../utils/format';

export default function Dashboard() {
  const { teamId } = useActiveTeam();
  const now = useNow(30_000);
  const { isLive } = useRealtime();

  const [range, setRange] = useState('24h');

  const loadSummary = useCallback(
    () => analyticsApi.summary({ teamId, range }),
    [teamId, range]
  );
  const loadActivity = useCallback(() => checksApi.recent({ teamId, limit: 12 }), [teamId]);
  const loadIncidents = useCallback(
    () => incidentsApi.list({ teamId, status: 'active', limit: 5 }),
    [teamId]
  );

  const summary = useAsync(loadSummary, [loadSummary]);
  const activity = useAsync(loadActivity, [loadActivity]);
  const incidents = useAsync(loadIncidents, [loadIncidents]);

  const data = summary.data;
  const activeIncidents = incidents.data?.incidents ?? [];

  const refreshAll = () => {
    summary.reload();
    activity.reload();
    incidents.reload();
  };

  // The scheduler writes the truth — reflect it without a manual refresh
  useLiveRefresh(refreshAll, ['monitor:status', 'monitor:check', 'incident:created', 'incident:updated', 'incident:resolved']);

  if (summary.loading && !data) return <LoadingState label="Loading your monitoring data…" />;
  if (summary.error && !data) {
    return <ErrorState error={summary.error} onRetry={summary.reload} />;
  }

  const hasChecks = (data?.checks?.total ?? 0) > 0;
  const hasMonitors = (data?.monitors?.total ?? 0) > 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">
            Live status for every monitor you can see
            {isLive && ' · live'}
            {data?.generatedAt && ` · updated ${formatRelative(data.generatedAt, now)}`}
          </p>
        </div>

        <div className="row">
          <label className="visually-hidden" htmlFor="range">
            Time range
          </label>
          <select
            id="range"
            className="select"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-secondary" onClick={refreshAll}>
            Refresh
          </button>
          <Link to="/app/monitors/new" className="btn btn-primary">
            + Add monitor
          </Link>
        </div>
      </header>

      {!hasMonitors && (
        <Alert type="info">
          You have no monitors yet. <Link to="/app/monitors/new">Add your first one</Link> and
          OpsPulse will start checking it automatically.
        </Alert>
      )}

      {data?.uptime?.unknownChecks > 0 && (
        <DataNote title="Data coverage:">
          {formatNumber(data.uptime.coveragePercentage, 1)}% of expected checks were recorded in this
          window. The remaining {formatNumber(data.uptime.unknownChecks)} were never run, so they are
          excluded from the uptime figure rather than counted as success.
        </DataNote>
      )}

      <div className="grid grid-stats">
        <Stat
          label="Total monitors"
          value={formatNumber(data?.monitors?.total ?? 0)}
          hint={`${data?.monitors?.pending ?? 0} not checked yet`}
          tone="brand"
        />
        <Stat label="Up" value={formatNumber(data?.monitors?.up ?? 0)} tone="up" />
        <Stat label="Down" value={formatNumber(data?.monitors?.down ?? 0)} tone="down" />
        <Stat
          label="Degraded"
          value={formatNumber(data?.monitors?.degraded ?? 0)}
          tone="degraded"
        />
        <Stat
          label="Uptime"
          value={data?.uptime?.percentage === null || data?.uptime?.percentage === undefined
            ? '—'
            : `${formatNumber(data.uptime.percentage, 2)}%`}
          hint={`from ${formatNumber(data?.checks?.total ?? 0)} real checks`}
          tone="brand"
        />
        <Stat
          label="Avg response"
          value={formatMs(data?.responseTime?.averageMs)}
          hint={
            data?.responseTime?.slowestMs
              ? `slowest ${formatMs(data.responseTime.slowestMs)}`
              : undefined
          }
          tone="brand"
        />
        <Stat
          label="Active incidents"
          value={
            incidents.loading && !incidents.data
              ? '…'
              : formatNumber(activeIncidents.length)
          }
          hint={activeIncidents.length ? 'needs attention' : 'all clear'}
          tone={activeIncidents.length ? 'down' : 'up'}
        />
      </div>

      {activeIncidents.length > 0 && (
        <Card>
          <CardHead
            title="Active incidents"
            subtitle="Opened automatically after repeated failures"
            actions={
              <Link to="/app/incidents" className="btn btn-ghost btn-sm">
                View all →
              </Link>
            }
          />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Incident</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Monitor</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {activeIncidents.map((incident) => (
                  <tr key={incident._id}>
                    <td>
                      <Link to={`/app/incidents/${incident._id}`} className="cell-strong">
                        {incident.title}
                      </Link>
                      <div className="cell-sub">{incident.lastError}</div>
                    </td>
                    <td>
                      <span
                        className={`badge ${incident.severity === 'critical' ? 'down' : incident.severity === 'warning' ? 'degraded' : 'paused'}`}
                      >
                        {incident.severity}
                      </span>
                    </td>
                    <td>{incident.monitor?.name ?? '—'}</td>
                    <td className="num">{incident.failureCount}</td>
                    <td className="num">{formatRelative(incident.startedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {hasChecks ? (
        <>
          <Card>
            <CardHead
              title="Average response time"
              subtitle="Measured on every check. Gaps mean no check was recorded in that period."
            />
            <ResponseTimeChart data={data.series} height={260} />
          </Card>

          <div className="grid grid-2">
            <Card>
              <CardHead title="Uptime over time" subtitle="Degraded checks count as half a success." />
              <UptimeChart data={data.series} height={230} />
            </Card>

            <Card>
              <CardHead title="Check outcomes" subtitle={`${formatNumber(data.checks.total)} checks in range`} />
              <StatusDonut
                counts={{
                  up: data.checks.up,
                  degraded: data.checks.degraded,
                  down: data.checks.down,
                }}
              />
            </Card>
          </div>
        </>
      ) : (
        <Card>
          <EmptyState
            icon="◔"
            title="No check data yet"
            message={
              hasMonitors
                ? 'The scheduler runs checks automatically. Data will appear here after the first check completes.'
                : 'Add a monitor and OpsPulse will start checking it on the configured interval.'
            }
            actionLabel={hasMonitors ? 'Run a check now' : undefined}
            actionTo={hasMonitors ? '/app/monitors' : '/app/monitors/new'}
          />
        </Card>
      )}

      <Card>
        <CardHead
          title="Recent monitoring activity"
          subtitle="The last 12 checks across all your monitors"
          actions={
            <Link to="/app/monitors" className="btn btn-ghost btn-sm">
              View all monitors →
            </Link>
          }
        />

        {activity.loading ? (
          <LoadingState label="Loading activity…" />
        ) : !activity.data?.activity?.length ? (
          <EmptyState icon="◷" title="No activity yet" message="Checks will appear here as soon as the scheduler runs." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Monitor</th>
                  <th scope="col">Status</th>
                  <th scope="col">Code</th>
                  <th scope="col">Response</th>
                  <th scope="col">Source</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {activity.data.activity.map((item) => (
                  <tr key={item._id}>
                    <td>
                      <div className="cell-strong">{item.monitorName}</div>
                      <div className="cell-sub">{item.monitorUrl}</div>
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="num">{item.statusCode ?? '—'}</td>
                    <td className="num">{formatMs(item.responseTimeMs)}</td>
                    <td>
                      <span className="badge">{item.source}</span>
                    </td>
                    <td className="num" title={new Date(item.checkedAt).toLocaleString()}>
                      {formatRelative(item.checkedAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}