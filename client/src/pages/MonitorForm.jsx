import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { monitorsApi } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/ui/ToastProvider';
import { Field, Alert } from '../components/ui/Primitives';
import { LoadingState } from '../components/ui/EmptyState';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const DEFAULTS = {
  name: '',
  url: '',
  method: 'GET',
  intervalSeconds: 300,
  timeoutMs: 10000,
  expectedStatusCodes: '200',
  expectedBodyText: '',
  degradedThresholdMs: 3000,
  failureThreshold: 3,
  recoveryThreshold: 1,
};

export default function MonitorForm() {
  const { monitorId } = useParams();
  const isEdit = Boolean(monitorId);
  const navigate = useNavigate();
  const toast = useToast();
  const { teams, activeTeamId } = useAuth();

  const [form, setForm] = useState({ ...DEFAULTS, team: activeTeamId ?? '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data: existing, loading } = useAsync(
    () => (isEdit ? monitorsApi.get(monitorId) : Promise.resolve(null)),
    [monitorId, isEdit]
  );

  useEffect(() => {
    if (!existing?.monitor) return;
    const m = existing.monitor;
    setForm({
      name: m.name,
      url: m.url,
      method: m.method,
      team: String(m.team),
      intervalSeconds: m.intervalSeconds,
      timeoutMs: m.timeoutMs,
      expectedStatusCodes: m.expectedStatusCodes.join(', '),
      expectedBodyText: m.expectedBodyText ?? '',
      degradedThresholdMs: m.degradedThresholdMs,
      failureThreshold: m.failureThreshold,
      recoveryThreshold: m.recoveryThreshold ?? 1,
    });
  }, [existing]);

  useEffect(() => {
    if (!isEdit && activeTeamId) setForm((f) => (f.team ? f : { ...f, team: activeTeamId }));
  }, [activeTeamId, isEdit]);

  const update = (key) => (e) => {
    const value = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((f) => ({ ...f, [key]: undefined }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const statusCodes = form.expectedStatusCodes
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));

    const payload = {
      name: form.name,
      url: form.url,
      method: form.method,
      intervalSeconds: Number(form.intervalSeconds),
      timeoutMs: Number(form.timeoutMs),
      expectedStatusCodes: statusCodes,
      expectedBodyText: form.expectedBodyText || '',
      degradedThresholdMs: Number(form.degradedThresholdMs),
      failureThreshold: Number(form.failureThreshold),
      recoveryThreshold: Number(form.recoveryThreshold),
    };

    if (!isEdit) payload.team = form.team;

    setBusy(true);
    try {
      if (isEdit) {
        await monitorsApi.update(monitorId, payload);
        toast.success('Monitor updated.');
        navigate(`/app/monitors/${monitorId}`);
      } else {
        const created = await monitorsApi.create(payload);
        toast.success(`Monitor "${created.monitor.name}" created. The first check runs automatically.`);
        navigate(`/app/monitors/${created.monitor.id}`);
      }
    } catch (err) {
      setFieldErrors(err.fieldErrors ?? {});
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (isEdit && loading) return <LoadingState label="Loading monitor…" />;

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <header className="page-head">
        <div>
          <h1>{isEdit ? 'Edit monitor' : 'Add a monitor'}</h1>
          <p className="subtitle">
            OpsPulse sends a real HTTP request to this address on your chosen interval. Private and
            internal addresses are blocked.
          </p>
        </div>
        <Link to="/app/monitors" className="btn btn-secondary">
          ← Back
        </Link>
      </header>

      {formError && <Alert type="error">{formError}</Alert>}

      <form onSubmit={onSubmit} className="stack" noValidate>
        <div className="card">
          <h2 className="card-title" style={{ marginBottom: 'var(--sp-4)' }}>
            What to monitor
          </h2>

          <div className="stack">
            <Field label="Monitor name" htmlFor="name" error={fieldErrors.name} required>
              <input
                id="name"
                className="input"
                value={form.name}
                onChange={update('name')}
                placeholder="Checkout API"
                required
                minLength={2}
                maxLength={80}
                aria-invalid={Boolean(fieldErrors.name)}
              />
            </Field>

            <Field
              label="URL"
              htmlFor="url"
              error={fieldErrors.url}
              hint="Example: https://api.example.com/health — localhost and private IP ranges are rejected."
              required
            >
              <input
                id="url"
                className="input"
                value={form.url}
                onChange={update('url')}
                placeholder="https://example.com/health"
                required
                aria-invalid={Boolean(fieldErrors.url)}
              />
            </Field>

            <div className="grid grid-2">
              <Field label="HTTP method" htmlFor="method" error={fieldErrors.method}>
                <select id="method" className="select" value={form.method} onChange={update('method')}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>

              {!isEdit && (
                <Field label="Workspace" htmlFor="team" error={fieldErrors.team} required>
                  <select id="team" className="select" value={form.team} onChange={update('team')} required>
                    <option value="">Select a workspace…</option>
                    {teams.map((team) => (
                      <option key={team._id ?? team.id} value={String(team._id ?? team.id)}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <h2 className="card-title" style={{ marginBottom: 'var(--sp-4)' }}>
            When and how
          </h2>

          <div className="stack">
            <Field
              label="Check every (seconds)"
              htmlFor="intervalSeconds"
              error={fieldErrors.intervalSeconds}
              hint="Minimum 30s. Going faster would hammer the target and can get your IP blocked."
              required
            >
              <div className="range-row">
                <input
                  id="intervalSeconds"
                  type="range"
                  min="30"
                  max="3600"
                  step="30"
                  value={form.intervalSeconds}
                  onChange={update('intervalSeconds')}
                />
                <span className="range-value">{form.intervalSeconds}s</span>
              </div>
            </Field>

            <Field
              label="Timeout (ms)"
              htmlFor="timeoutMs"
              error={fieldErrors.timeoutMs}
              hint="A check that takes longer than this is recorded as a timeout."
              required
            >
              <div className="range-row">
                <input
                  id="timeoutMs"
                  type="range"
                  min="1000"
                  max="30000"
                  step="500"
                  value={form.timeoutMs}
                  onChange={update('timeoutMs')}
                />
                <span className="range-value">{form.timeoutMs} ms</span>
              </div>
            </Field>

            <Field
              label="Response slower than (ms) is DEGRADED"
              htmlFor="degradedThresholdMs"
              error={fieldErrors.degradedThresholdMs}
              hint="Set to 0 to never report degraded."
            >
              <div className="range-row">
                <input
                  id="degradedThresholdMs"
                  type="range"
                  min="0"
                  max="20000"
                  step="250"
                  value={form.degradedThresholdMs}
                  onChange={update('degradedThresholdMs')}
                />
                <span className="range-value">
                  {Number(form.degradedThresholdMs) === 0 ? 'off' : `${form.degradedThresholdMs} ms`}
                </span>
              </div>
            </Field>
          </div>
        </div>

        <div className="card">
          <h2 className="card-title" style={{ marginBottom: 'var(--sp-4)' }}>
            What counts as healthy
          </h2>

          <div className="stack">
            <Field
              label="Expected HTTP status codes"
              htmlFor="expectedStatusCodes"
              error={fieldErrors.expectedStatusCodes}
              hint="Comma separated, e.g. 200 or 200, 201, 204"
              required
            >
              <input
                id="expectedStatusCodes"
                className="input"
                value={form.expectedStatusCodes}
                onChange={update('expectedStatusCodes')}
                placeholder="200"
                aria-invalid={Boolean(fieldErrors.expectedStatusCodes)}
              />
            </Field>

            <Field
              label="Expected response text (optional)"
              htmlFor="expectedBodyText"
              error={fieldErrors.expectedBodyText}
              hint="If set, the body must contain this text or the check fails."
            >
              <input
                id="expectedBodyText"
                className="input"
                value={form.expectedBodyText}
                onChange={update('expectedBodyText')}
                placeholder='"status":"ok"'
                maxLength={200}
              />
            </Field>

            <div className="grid grid-2">
              <Field
                label="Recover after N good checks"
                htmlFor="recoveryThreshold"
                error={fieldErrors.recoveryThreshold}
                hint="Higher values stop a flapping service from looking healthy instantly."
              >
                <input
                  id="recoveryThreshold"
                  type="number"
                  className="input"
                  min="1"
                  max="10"
                  value={form.recoveryThreshold}
                  onChange={update('recoveryThreshold')}
                />
              </Field>

              <Field
                label="Open an incident after N failures"
                htmlFor="failureThreshold"
                error={fieldErrors.failureThreshold}
                hint="Used when incident detection is switched on."
              >
                <input
                  id="failureThreshold"
                  type="number"
                  className="input"
                  min="1"
                  max="20"
                  value={form.failureThreshold}
                  onChange={update('failureThreshold')}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Link to="/app/monitors" className="btn btn-secondary">
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {isEdit ? 'Save changes' : 'Create monitor'}
          </button>
        </div>
      </form>
    </div>
  );
}