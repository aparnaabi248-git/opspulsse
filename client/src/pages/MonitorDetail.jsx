import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { analyticsApi, incidentsApi, monitorsApi } from '../api';
import { useAsync, useNow } from '../hooks/useAsync';
import { useLiveRefresh } from '../context/RealtimeContext';
import { useToast } from '../components/ui/ToastProvider';
import { Card, CardHead, Stat, DefinitionList, Alert, Pagination } from '../components/ui/Primitives';
import DataNote from '../components/ui/DataNote';
import StatusBadge from '../components/ui/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import {
  ResponseTimeRangeChart,
  UptimeChart,
  DailyUptimeChart,
} from '../components/charts/Charts';
import { RANGE_OPTIONS, CHART_COLORS } from '../utils/status';
import {
  formatMs,
  formatNumber,
  formatRelative,
  formatDateTime,
  formatDuration,
} from '../utils/format';

export default function MonitorDetail() {
  const { monitorId } = useParams();
  const toast = useToast();
  const now = useNow(20_000);

  const [range, setRange] = useState('24h');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const loadMonitor = useCallback(() => monitorsApi.get(monitorId), [monitorId]);
  const loadAnalytics = useCallback(
    () => analyticsApi.monitor(monitorId, { range }),
    [monitorId, range]
  );
  const loadHistory = useCallback(
    () => monitorsApi.history(monitorId, { page, limit: 20 }),
    [monitorId, page]
  );
  const loadIncidents = useCallback(
    () => incidentsApi.list({ monitor: monitorId, limit: 10 }),
    [monitorId]
  );

  const monitorQ = useAsync(loadMonitor, [loadMonitor]);
  const analyticsQ = useAsync(loadAnalytics, [loadAnalytics]);
  const historyQ = useAsync(loadHistory, [loadHistory]);
  const incidentsQ = useAsync(loadIncidents, [loadIncidents]);

  const monitor = monitorQ.data?.monitor;

  // A scheduled check should update this page without a manual refresh
  useLiveRefresh(
    () => {
      monitorQ.reload();
      historyQ.reload();
      analyticsQ.reload();
      incidentsQ.reload();
    },
    ['monitor:status', 'monitor:check', 'incident:created', 'incident:updated', 'incident:resolved']
  );

  const runCheck = async () => {
    setBusy(true);
    try {
      const result = await monitorsApi.runCheck(monitorId);
      monitorQ.reload();
      historyQ.reload();
      analyticsQ.reload();
      if (result.status === 'up') toast.success(`Check passed in ${formatMs(result.responseTimeMs)} (HTTP ${result.statusCode}).`);
      else toast.error(`Check failed: ${result.errorMessage ?? result.status}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    setBusy(true);
    try {
      const result = monitor.isPaused
        ? await monitorsApi.resume(monitorId)
        : await monitorsApi.pause(monitorId);
      monitorQ.reload();
      toast.success(result.message);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (monitorQ.loading && !monitor) return <LoadingState label="Loading monitor…" />;
  if (monitorQ.error) return <ErrorState error={monitorQ.error} onRetry={monitorQ.reload} />;
  if (!monitor) return <ErrorState error={{ message: 'Monitor not found.' }} />;

  const analytics = analyticsQ.data;
  const history = historyQ.data?.checks ?? [];
  const monitorIncidents = incidentsQ.data?.incidents ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row">
            <Link to="/app/monitors" className="btn btn-ghost btn-sm">
              ← Monitors
            </Link>
            <StatusBadge
              status={monitor.status}
              pulse={monitor.status === 'down' || monitor.status === 'degraded'}
            />
          </div>
          <h1 style={{ marginTop: 'var(--sp-2)', wordBreak: 'break-word' }}>{monitor.name}</h1>
          <p className="subtitle mono" style={{ wordBreak: 'break-all' }}>
            {monitor.method} {monitor.url}
          </p>
        </div>

        <div className="row">
          <label className="visually-hidden" htmlFor="detail-range">
            Time range
          </label>
          <select
            id="detail-range"
            className="select"
            value={range}
            onChange={(e) => {
              setRange(e.target.value);
              setPage(1);
            }}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={togglePause}
            disabled={busy}
          >
            {monitor.isPaused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={runCheck}
            disabled={busy || monitor.isPaused}
            title={monitor.isPaused ? 'Resume the monitor before running a check' : 'Run a check now'}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            Check now
          </button>
          <Link to={`/app/monitors/${monitorId}/edit`} className="btn btn-secondary">
            Edit
          </Link>
        </div>
      </header>

      {monitor.isPaused && (
        <Alert type="info">
          This monitor is paused — scheduled checks are switched off. Resume it to keep monitoring.
        </Alert>
      )}

      {monitor.isRecovering && monitor.recoveryProgress && (
        <Alert type="info">
          The last check succeeded, but this monitor needs {monitor.recoveryProgress.needed}{' '}
          consecutive successes before it is marked UP again (
          {monitor.recoveryProgress.done}/{monitor.recoveryProgress.needed} so far).
        </Alert>
      )}

      {monitor.lastError && monitor.status === 'down' && (
        <Alert type="error">
          Last failure: {monitor.lastError}
          {monitor.downtime?.currentSince &&
            ` · down since ${formatRelative(monitor.downtime.currentSince, now)}`}
        </Alert>
      )}

      <div className="grid grid-stats">
        <Stat
          label="Uptime"
          value={
            analytics?.uptime?.percentage === null || analytics?.uptime?.percentage === undefined
              ? '—'
              : `${formatNumber(analytics.uptime.percentage, 2)}%`
          }
          hint={`${formatNumber(analytics?.uptime?.totalRecordedChecks ?? 0)} checks recorded`}
          tone="brand"
        />
        <Stat
          label="Avg response"
          value={formatMs(analytics?.responseTime?.averageMs)}
          hint={`p95 ${formatMs(analytics?.responseTime?.p95Ms)}`}
          tone="brand"
        />
        <Stat
          label="Downtime"
          value={formatDuration(analytics?.reliability?.downtimeMs ?? 0)}
          hint={`${formatNumber(analytics?.reliability?.failedChecks ?? 0)} failed checks`}
          tone="down"
        />
        <Stat
          label="Outage episodes"
          value={formatNumber(analytics?.reliability?.failureRuns ?? 0)}
          hint="separate failure runs in range"
          tone="degraded"
        />
      </div>

      {analytics?.uptime?.unknownChecks > 0 && (
        <DataNote title="Data coverage:">
          {formatNumber(analytics.uptime.coveragePercentage, 1)}% of expected checks were recorded.
          The {formatNumber(analytics.uptime.unknownChecks)} that were never run are excluded from the
          uptime figure rather than counted as success.
        </DataNote>
      )}

      {analyticsQ.loading && !analytics ? (
        <LoadingState label="Calculating analytics from real check history…" />
      ) : analytics ? (
        <>
          <Card>
            <CardHead
              title="Response time"
              subtitle="Slowest, average and fastest check in each period. Gaps mean no check ran."
            />
            <ResponseTimeRangeChart data={analytics.series} height={260} />
          </Card>

          <div className="grid grid-2">
            <Card>
              <CardHead title="Uptime over time" subtitle="Degraded counts as half a success." />
              <UptimeChart data={analytics.series} height={230} />
            </Card>

            <Card>
              <CardHead title="Configuration" subtitle="How this monitor is checked" />
              <DefinitionList
                items={[
                  { label: 'Method', value: <span className="mono">{monitor.method}</span> },
                  { label: 'Interval', value: `${monitor.intervalSeconds} seconds` },
                  { label: 'Timeout', value: `${monitor.timeoutMs} ms` },
                  { label: 'Expected codes', value: monitor.expectedStatusCodes.join(', ') },
                  { label: 'Expected text', value: monitor.expectedBodyText || '—' },
                  { label: 'Degraded above', value: monitor.degradedThresholdMs === 0 ? 'disabled' : `${monitor.degradedThresholdMs} ms` },
                  { label: 'Recovery threshold', value: `${monitor.recoveryThreshold} good check(s)` },
                  { label: 'Failure threshold', value: `${monitor.failureThreshold} failed check(s)` },
                  { label: 'Next check', value: monitor.isPaused ? 'paused' : formatRelative(monitor.nextCheckAt, now) },
                  { label: 'Resolved IP', value: monitor.lastResolvedIp ? <span className="mono">{monitor.lastResolvedIp}</span> : '—' },
                ]}
              />
            </Card>
          </div>

          {analytics.daily?.length > 1 && (
            <Card>
              <CardHead title="Daily summary" subtitle="Uptime per calendar day (UTC)" />
              <DailyUptimeChart data={analytics.daily} />
            </Card>
          )}
        </>
      ) : null}

      <Card>
        <CardHead
          title="Incidents"
          subtitle={`${monitorIncidents.length} recorded for this monitor`}
          actions={
            <Link to={`/app/incidents?search=${encodeURIComponent(monitor.name)}`} className="btn btn-ghost btn-sm">
              All incidents →
            </Link>
          }
        />
        {incidentsQ.loading ? (
          <LoadingState label="Loading incidents…" />
        ) : monitorIncidents.length === 0 ? (
          <EmptyState
            icon="✓"
            title="No incidents for this monitor"
            message="An incident is opened only after the monitor fails several checks in a row."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Incident</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {monitorIncidents.map((incident) => (
                  <tr key={incident._id}>
                    <td>
                      <Link to={`/app/incidents/${incident._id}`} className="cell-strong">
                        {incident.title}
                      </Link>
                      <div className="cell-sub">{incident.lastError}</div>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          incident.severity === 'critical'
                            ? 'down'
                            : incident.severity === 'warning'
                              ? 'degraded'
                              : 'paused'
                        }`}
                      >
                        {incident.severity}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${incident.status === 'resolved' ? 'up' : 'down'}`}>
                        {incident.status}
                      </span>
                    </td>
                    <td className="num">{incident.failureCount}</td>
                    <td className="num">{formatRelative(incident.startedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHead
          title="Check history"
          subtitle={
            historyQ.data
              ? `${formatNumber(historyQ.data.pagination.total)} checks stored`
              : 'Every check ever run, newest first'
          }
          actions={
            <button type="button" className="btn btn-ghost btn-sm" onClick={historyQ.reload}>
              Refresh
            </button>
          }
        />

        {historyQ.loading ? (
          <LoadingState label="Loading history…" />
        ) : history.length === 0 ? (
          <EmptyState
            icon="◷"
            title="No checks recorded yet"
            message="Press “Check now” to run an immediate check, or wait for the scheduler tick."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">HTTP</th>
                    <th scope="col">Response</th>
                    <th scope="col">Source</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((check) => (
                    <tr key={check._id}>
                      <td>
                        <span className={`badge ${check.status}`}>
                          <span
                            className="dot"
                            style={{
                              background: CHART_COLORS[check.status] ?? 'var(--paused)',
                            }}
                            aria-hidden="true"
                          />
                          {check.status}
                        </span>
                      </td>
                      <td>
                        <div>{check.outcome}</div>
                        {check.errorMessage && (
                          <div className="cell-sub" style={{ color: 'var(--down)' }}>
                            {check.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="num">{check.statusCode ?? '—'}</td>
                      <td className="num">{formatMs(check.responseTimeMs)}</td>
                      <td>
                        <span className="badge">{check.source}</span>
                      </td>
                      <td className="num" title={formatDateTime(check.checkedAt)}>
                        {formatRelative(check.checkedAt, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 'var(--sp-4)' }}>
              <Pagination meta={historyQ.data.pagination} onChange={setPage} />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}