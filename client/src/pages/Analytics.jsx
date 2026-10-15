import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { analyticsApi } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useActiveTeam } from '../context/AuthContext';
import { Card, CardHead, Stat, Alert, Pagination } from '../components/ui/Primitives';
import DataNote from '../components/ui/DataNote';
import StatusBadge from '../components/ui/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { ResponseTimeChart, StatusDonut } from '../components/charts/Charts';
import { RANGE_OPTIONS } from '../utils/status';
import { formatMs, formatNumber, truncateUrl } from '../utils/format';

export default function Analytics() {
  const { teamId } = useActiveTeam();
  const [range, setRange] = useState('24h');
  const [page, setPage] = useState(1);
  const perPage = 12;

  const load = useCallback(
    () => analyticsApi.monitorTable({ teamId, range }),
    [teamId, range]
  );
  const loadSummary = useCallback(() => analyticsApi.summary({ teamId, range }), [teamId, range]);

  const table = useAsync(load, [load]);
  const summary = useAsync(loadSummary, [loadSummary]);

  const monitors = table.data?.monitors ?? [];
  const paged = monitors.slice((page - 1) * perPage, page * perPage);
  const meta = {
    page,
    limit: perPage,
    total: monitors.length,
    totalPages: Math.ceil(monitors.length / perPage),
    hasPrevPage: page > 1,
    hasNextPage: page < Math.ceil(monitors.length / perPage),
  };

  const sorted = [...monitors].sort((a, b) => {
    const rank = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };
    const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    // Then slowest first
    return (b.avgResponseTimeMs ?? 0) - (a.avgResponseTimeMs ?? 0);
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="subtitle">
            Uptime and latency per monitor, calculated from persisted check results
          </p>
        </div>
        <div className="row">
          <label className="visually-hidden" htmlFor="analytics-range">
            Time range
          </label>
          <select id="analytics-range" className="select" value={range} onChange={(e) => { setRange(e.target.value); setPage(1); }}>
            {RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              table.reload();
              summary.reload();
            }}
          >
            Refresh
          </button>
        </div>
      </header>

      {summary.data?.uptime?.unknownChecks > 0 && (
        <DataNote title="Data coverage:">
          {formatNumber(summary.data.uptime.coveragePercentage, 1)}% of expected checks were
          recorded.{' '}
          {formatNumber(summary.data.uptime.unknownChecks)} were never run and are excluded from the
          uptime figure rather than counted as success.
        </DataNote>
      )}

      <div className="grid grid-stats">
        <Stat
          label="Workspace uptime"
          value={
            summary.data?.uptime?.percentage === null || summary.data?.uptime?.percentage === undefined
              ? '—'
              : `${formatNumber(summary.data.uptime.percentage, 2)}%`
          }
          hint={`${formatNumber(summary.data?.checks?.total ?? 0)} checks in range`}
          tone="brand"
        />
        <Stat
          label="Average response"
          value={formatMs(summary.data?.responseTime?.averageMs)}
          hint={`slowest ${formatMs(summary.data?.responseTime?.slowestMs)}`}
          tone="brand"
        />
        <Stat
          label="Checks recorded"
          value={formatNumber(summary.data?.checks?.total ?? 0)}
          hint="real persisted results"
          tone="up"
        />
        <Stat
          label="Coverage"
          value={`${formatNumber(summary.data?.uptime?.coveragePercentage ?? 0, 1)}%`}
          hint="of expected checks actually recorded"
          tone={summary.data?.uptime?.coveragePercentage < 95 ? 'degraded' : 'up'}
        />
      </div>

      {summary.data?.series?.length > 0 && (
        <Card>
          <CardHead
            title="Workspace response time"
            subtitle="Average across every monitor in this workspace"
          />
          <ResponseTimeChart data={summary.data.series} height={240} />
        </Card>
      )}

      <Card>
        <CardHead
          title="Per-monitor performance"
          subtitle="Sorted by status, then slowest first"
          actions={
            summary.data ? (
              <div style={{ width: 200 }}>
                <StatusDonut
                  counts={{
                    up: summary.data.checks.up,
                    degraded: summary.data.checks.degraded,
                    down: summary.data.checks.down,
                  }}
                  height={160}
                />
              </div>
            ) : null
          }
        />

        {table.loading && !table.data ? (
          <LoadingState label="Calculating analytics…" />
        ) : table.error ? (
          <ErrorState error={table.error} onRetry={table.reload} />
        ) : monitors.length === 0 ? (
          <EmptyState
            icon="◔"
            title="No monitors to analyse"
            message="Once you add a monitor and checks run, uptime and latency appear here."
            actionLabel="Add a monitor"
            actionTo="/app/monitors/new"
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Monitor</th>
                    <th scope="col">Status</th>
                    <th scope="col">Uptime</th>
                    <th scope="col">Avg response</th>
                    <th scope="col">Checks</th>
                    <th scope="col">Failures</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((monitor) => {
                    const source = sorted.find((m) => m.id === monitor.id);
                    void source;
                    return (
                      <tr key={monitor.id}>
                        <td>
                          <Link to={`/app/monitors/${monitor.id}`} className="cell-strong">
                            {monitor.name}
                          </Link>
                          <div className="cell-sub">{truncateUrl(monitor.url, 48)}</div>
                        </td>
                        <td>
                          <StatusBadge status={monitor.status} />
                        </td>
                        <td className="num">
                          {monitor.uptimePercentage === null ? (
                            <span className="cell-sub">no data</span>
                          ) : (
                            `${formatNumber(monitor.uptimePercentage, 2)}%`
                          )}
                        </td>
                        <td className="num">{formatMs(monitor.avgResponseTimeMs)}</td>
                        <td className="num">{formatNumber(monitor.checksInRange)}</td>
                        <td className="num" style={{ color: monitor.downInRange ? 'var(--down)' : undefined }}>
                          {formatNumber(monitor.downInRange)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {monitors.length > perPage && (
              <div style={{ marginTop: 'var(--sp-4)' }}>
                <Pagination meta={meta} onChange={setPage} />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}