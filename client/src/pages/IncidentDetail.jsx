import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { incidentsApi } from '../api';
import { useAsync, useNow } from '../hooks/useAsync';
import { useLiveRefresh } from '../context/RealtimeContext';
import { useToast } from '../components/ui/ToastProvider';
import { Card, CardHead, Stat, Alert, DefinitionList, Field } from '../components/ui/Primitives';
import { LoadingState, ErrorState } from '../components/ui/EmptyState';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
} from '../utils/format';
import { CHART_COLORS } from '../utils/status';

const SEVERITY_TONE = { critical: 'down', warning: 'degraded', info: 'paused' };

const TIMELINE_COLORS = {
  created: CHART_COLORS.down,
  failed_check: CHART_COLORS.down,
  acknowledged: CHART_COLORS.degraded,
  note: CHART_COLORS.brand,
  recovery: CHART_COLORS.up,
  resolved: CHART_COLORS.up,
};

const TIMELINE_LABELS = {
  created: 'Incident opened',
  failed_check: 'Failed check',
  acknowledged: 'Acknowledged',
  note: 'Note',
  recovery: 'Recovered',
  resolved: 'Resolved',
};

export default function IncidentDetail() {
  const { incidentId } = useParams();
  const toast = useToast();
  const now = useNow(20_000);

  const [busy, setBusy] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(null);

  const load = useCallback(() => incidentsApi.get(incidentId), [incidentId]);
  const { data, loading, error, reload } = useAsync(load, [load]);

  useLiveRefresh(reload, ['incident:created', 'incident:updated', 'incident:resolved', 'monitor:status']);

  const incident = data?.incident;

  const acknowledge = async () => {
    setBusy(true);
    try {
      const result = await incidentsApi.acknowledge(incidentId);
      toast.success(result.message);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    setBusy(true);
    try {
      const result = await incidentsApi.resolve(incidentId, notes.trim());
      toast.success(result.message);
      setResolveOpen(false);
      setNotes('');
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitNote = async (e) => {
    e.preventDefault();
    setNoteError(null);
    if (note.trim().length < 2) {
      setNoteError('A note needs at least 2 characters.');
      return;
    }
    setBusy(true);
    try {
      await incidentsApi.addNote(incidentId, note.trim());
      setNote('');
      toast.success('Note added to the timeline.');
      reload();
    } catch (err) {
      setNoteError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading incident…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!incident) return <ErrorState error={{ message: 'Incident not found.' }} />;

  const resolved = incident.status === 'resolved';

  return (
    <div className="page">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row">
            <Link to="/app/incidents" className="btn btn-ghost btn-sm">
              ← Incidents
            </Link>
            <span className={`badge ${SEVERITY_TONE[incident.severity] ?? 'paused'}`}>
              {incident.severity}
            </span>
            <span className={`badge ${resolved ? 'up' : 'down'}`}>{incident.status}</span>
          </div>
          <h1 style={{ marginTop: 'var(--sp-2)' }}>{incident.title}</h1>
          {incident.monitor && (
            <p className="subtitle">
              <Link to={`/app/monitors/${incident.monitor._id}`}>
                {incident.monitor.name}
              </Link>{' '}
              · {incident.monitor.method} {incident.monitor.url}
            </p>
          )}
        </div>

        <div className="row">
          {!resolved && incident.status === 'open' && (
            <button type="button" className="btn btn-secondary" onClick={acknowledge} disabled={busy}>
              Acknowledge
            </button>
          )}
          {!resolved && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setResolveOpen(true)}
              disabled={busy}
            >
              Resolve incident
            </button>
          )}
          {resolved && (
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Resolved {formatRelative(incident.resolvedAt, now)}
            </span>
          )}
        </div>
      </header>

      {incident.monitor && !resolved && (
        <Alert type="error">
          {incident.monitor.name} is currently{' '}
          <strong>{incident.monitor.status?.toUpperCase()}</strong>. This incident will close
          automatically once the monitor responds normally again.
        </Alert>
      )}

      {resolved && (
        <Alert type="success">
          {incident.resolutionNotes || 'Resolved.'}{' '}
          {incident.resolvedBy?.name ? `— ${incident.resolvedBy.name}` : ''}
        </Alert>
      )}

      <div className="grid grid-stats">
        <Stat
          label="Duration"
          value={formatDuration(incident.durationMs)}
          hint={resolved ? 'total outage time' : 'still ongoing'}
          tone={resolved ? 'up' : 'down'}
        />
        <Stat
          label="Failed checks"
          value={formatNumber(incident.failureCount)}
          hint="checks during this incident"
          tone="degraded"
        />
        <Stat
          label="Started"
          value={formatRelative(incident.startedAt, now)}
          hint={formatDateTime(incident.startedAt)}
          tone="brand"
        />
        <Stat
          label="Acknowledged"
          value={
            incident.acknowledgedAt ? formatRelative(incident.acknowledgedAt, now) : 'Not yet'
          }
          hint={incident.acknowledgedBy?.name ?? 'nobody has picked this up'}
          tone="brand"
        />
      </div>

      <div className="grid grid-2">
        <Card>
          <CardHead title="Details" />
          {incident.description && (
            <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--sp-4)', fontSize: 'var(--text-sm)' }}>
              {incident.description}
            </p>
          )}
          <DefinitionList
            items={[
              { label: 'Monitor', value: incident.monitor?.name ?? 'deleted' },
              { label: 'Severity', value: incident.severity },
              { label: 'Status', value: incident.status },
              { label: 'Started', value: formatDateTime(incident.startedAt) },
              { label: 'Resolved', value: incident.resolvedAt ? formatDateTime(incident.resolvedAt) : '—' },
              { label: 'Recorded downtime', value: incident.downtimeMs != null ? formatDuration(incident.downtimeMs) : '—' },
              { label: 'Last error', value: <span style={{ color: 'var(--down)' }}>{incident.lastError || '—'}</span> },
              { label: 'Timeline entries', value: formatNumber(incident.timeline.length) },
            ]}
          />
        </Card>

        <Card>
          <CardHead
            title="Timeline"
            subtitle="Every event recorded for this incident"
          />

          {!resolved && (
            <form onSubmit={submitNote} className="stack-sm" style={{ marginBottom: 'var(--sp-5)' }}>
              <Field label="Add a note" htmlFor="note" error={noteError}>
                <input
                  id="note"
                  className="input"
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setNoteError(null);
                  }}
                  placeholder="What did you find? What are you doing?"
                  maxLength={1000}
                />
              </Field>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
                  Add note
                </button>
              </div>
            </form>
          )}

          <div className="timeline scroll-list">
            {incident.timeline.map((entry, index) => (
              <div className="timeline-item" key={`${entry._id ?? index}-${entry.at}`}>
                <span
                  className="timeline-dot"
                  style={{ background: TIMELINE_COLORS[entry.type] ?? CHART_COLORS.brand }}
                  aria-hidden="true"
                />
                <div className="timeline-body">
                  <div className="row" style={{ gap: 'var(--sp-2)' }}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>
                      {TIMELINE_LABELS[entry.type] ?? entry.type}
                    </strong>
                    <span className="timeline-time">{formatRelative(entry.at, now)}</span>
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                    {entry.message}
                  </div>
                  {entry.actor?.name && (
                    <div className="timeline-time">by {entry.actor.name}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {resolveOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setResolveOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="resolve-title">
            <h2 id="resolve-title">Resolve this incident?</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--sp-4)', fontSize: 'var(--text-sm)' }}>
              Use <strong>Resolve</strong> only when the problem is genuinely fixed. The monitor is
              still down, so OpsPulse will report it again on the next failed check.
            </p>
            <Field
              label="Resolution notes"
              htmlFor="resolution-notes"
              hint="What was the cause and what fixed it? This is stored permanently."
            >
              <textarea
                id="resolution-notes"
                className="textarea"
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Rolled back the bad deploy and restarted the worker pool."
                maxLength={2000}
              />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-4)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setResolveOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={resolve} disabled={busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                Resolve incident
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}