import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { reportsApi, monitorsApi } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useActiveTeam } from '../context/AuthContext';
import { useLiveRefresh } from '../context/RealtimeContext';
import { Card, CardHead, Stat, Alert } from '../components/ui/Primitives';
import DataNote from '../components/ui/DataNote';
import { UptimeChart, ResponseTimeChart } from '../components/charts/Charts';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { formatMs, formatNumber, formatDuration } from '../utils/format';

const DAY_OPTIONS = [7, 14, 30, 60, 90];
const WEEK_OPTIONS = [4, 8, 12, 26, 52];

export default function Reports() {
  const { teamId } = useActiveTeam();

  const [mode, setMode] = useState('daily');
  const [days, setDays] = useState(30);
  const [weeks, setWeeks] = useState(12);
  const [monitorId, setMonitorId] = useState('');

  const loadMonitors = useCallback(() => monitorsApi.list({ teamId, limit: 100 }), [teamId]);
  const { data: monitorData } = useAsync(loadMonitors, [loadMonitors]);
  const monitors = monitorData?.monitors ?? [];

  const loadReport = useCallback(
    () =>
      mode === 'daily'
        ? reportsApi.daily({ teamId, days, monitor: monitorId || undefined })
        : reportsApi.weekly({ teamId, weeks, monitor: monitorId || undefined }),
    [mode, teamId, days, weeks, monitorId]
  );

  const { data, loading, error, reload } = useAsync(loadReport, [loadReport]);

  useLiveRefresh(reload, ['monitor:status', 'monitor:check', 'incident:resolved']);

  const periods = data?.periods ?? [];
  const chartData = periods.map((p) => ({
    at: p.periodStart,
    uptimePercentage: p.uptimePercentage,
    avgResponseTime: p.avgResponseTime,
  }));

  const withData = periods.filter((p) => p.total > 0);
  const options = mode === 'daily' ? DAY_OPTIONS : WEEK_OPTIONS;
  const selected = mode === 'daily' ? days : weeks;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="subtitle">
            Daily and weekly summaries built from persisted check results. Periods with no checks are
            shown as gaps, never as 100%.
          </p>
        </div>

        <div className="row">
          <div className="chip-row" role="group" aria-label="Report period">
            <button
              type="button"
              className={`chip${mode === 'daily' ? ' active' : ''}`}
              onClick={() => setMode('daily')}
            >
              Daily
            </button>
            <button
              type="button"
              className={`chip${mode === 'weekly' ? ' active' : ''}`}
              onClick={() => setMode('weekly')}
            >
              Weekly
            </button>
          </div>

          <label className="visually-hidden" htmlFor="report-span">
            How far back
          </label>
          <select
            id="report-span"
            className="select"
            value={selected}
            onChange={(e) =>
              mode === 'daily' ? setDays(Number(e.target.value)) : setWeeks(Number(e.target.value))
            }
          >
            {options.map((n) => (
              <option key={n} value={n}>
                {mode === 'daily' ? `Last ${n} days` : `Last ${n} weeks`}
              </option>
            ))}
          </select>

          <label className="visually-hidden" htmlFor="report-monitor">
            Monitor
          </label>
          <select
            id="report-monitor"
            className="select"
            value={monitorId}
            onChange={(e) => setMonitorId(e.target.value)}
          >
            <option value="">All monitors</option>
            {monitors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          <button type="button" className="btn btn-secondary" onClick={reload}>
            Refresh
          </button>
        </div>
      </header>

      {loading && !data ? (
        <LoadingState label="Building the report from real check history…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : withData.length === 0 ? (
        <Card>
          <EmptyState
            icon="◷"
            title="No check data in this period"
            message={
              monitors.length === 0
                ? 'Add a monitor first — reports are built from real checks.'
                : 'Nothing has been recorded in this window yet. Try a longer period.'
            }
            actionLabel={monitors.length === 0 ? 'Add a monitor' : undefined}
            actionTo={monitors.length === 0 ? '/app/monitors/new' : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-stats">
            <Stat
              label="Checks recorded"
              value={formatNumber(data.totals.checks)}
              hint={`${withData.length} ${mode === 'daily' ? 'days' : 'weeks'} with data`}
              tone="brand"
            />
            <Stat
              label="Best period"
              value={`${formatNumber(data.totals.bestUptime, 2)}%`}
              tone="up"
            />
            <Stat
              label="Worst period"
              value={`${formatNumber(data.totals.worstUptime, 2)}%`}
              tone="down"
            />
            <Stat
              label="Avg response"
              value={formatMs(data.totals.avgResponseTime)}
              tone="brand"
            />
            <Stat
              label="Incidents"
              value={formatNumber(data.totals.incidents)}
              tone={data.totals.incidents ? 'degraded' : 'up'}
            />
            <Stat
              label="Empty periods"
              value={formatNumber(data.totals.daysWithNoData ?? data.totals.weeksWithNoData ?? 0)}
              hint="no checks recorded"
              tone="paused"
            />
          </div>

          {(data.totals.daysWithNoData ?? data.totals.weeksWithNoData ?? 0) > 0 && (
            <DataNote title="Empty periods:">
              {formatNumber(
                data.totals.daysWithNoData ?? data.totals.weeksWithNoData ?? 0
              )}{' '}
              {mode === 'daily' ? 'days' : 'weeks'} in this range have no recorded checks. They are
              left blank in the charts rather than counted as uptime, because a check that never ran is
              not a passing check.
            </DataNote>
          )}

          <Card>
            <CardHead
              title="Uptime per period"
              subtitle={`${mode === 'daily' ? 'Daily' : 'Weekly'} uptime, degraded counts as half a success`}
            />
            <UptimeChart data={chartData} height={250} />
          </Card>

          <Card>
            <CardHead title="Average response time per period" />
            <ResponseTimeChart data={chartData} height={230} />
          </Card>

          <Card>
            <CardHead
              title="Detailed breakdown"
              subtitle={`Every ${mode === 'daily' ? 'day' : 'week'} in the range`}
            />
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Checks</th>
                    <th scope="col">Up</th>
                    <th scope="col">Down</th>
                    <th scope="col">Avg response</th>
                    <th scope="col">Uptime</th>
                    <th scope="col">Incidents</th>
                    <th scope="col">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {[...periods].reverse().map((period) => (
                    <tr key={period.periodStart}>
                      <td className="cell-strong">
                        {new Date(period.periodStart).toLocaleDateString(undefined, {
                          month: 'short',
                          day: '2-digit',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="num">{period.total === 0 ? '—' : period.total}</td>
                      <td className="num">{period.total === 0 ? '—' : period.up}</td>
                      <td className="num" style={{ color: period.down ? 'var(--down)' : undefined }}>
                        {period.total === 0 ? '—' : period.down}
                      </td>
                      <td className="num">
                        {period.total === 0 ? '—' : formatMs(period.avgResponseTime)}
                      </td>
                      <td className="num">
                        {period.total === 0 ? (
                          <span className="cell-sub">no data</span>
                        ) : (
                          `${formatNumber(period.uptimePercentage, 2)}%`
                        )}
                      </td>
                      <td className="num">{period.incidents || '—'}</td>
                      <td className="num">
                        {period.coveragePercentage == null
                          ? '—'
                          : `${formatNumber(period.coveragePercentage, 1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {monitorId && (
              <p className="hint" style={{ marginTop: 'var(--sp-3)' }}>
                Filtered to{' '}
                <Link to={`/app/monitors/${monitorId}`}>
                  {monitors.find((m) => m.id === monitorId)?.name ?? 'this monitor'}
                </Link>
                . Total range covered: {formatDuration(
                  (new Date(data.to).getTime() - new Date(data.from).getTime())
                )}
                .
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}