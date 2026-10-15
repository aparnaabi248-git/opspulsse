import { useCallback, useEffect, useState } from 'react';
import { settingsApi, authApi } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useRealtime } from '../context/RealtimeContext';
import { useToast } from '../components/ui/ToastProvider';
import { Card, CardHead, Field, Alert } from '../components/ui/Primitives';
import DataNote from '../components/ui/DataNote';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { LoadingState, ErrorState } from '../components/ui/EmptyState';

const ALERT_TYPES = [
  { value: 'monitor_down', label: 'Monitor is down', hint: 'A monitor failed its failure threshold.' },
  { value: 'monitor_recovered', label: 'Monitor recovered', hint: 'A monitor came back up.' },
  { value: 'monitor_degraded', label: 'Monitor is degraded', hint: 'Responses are slower than the threshold.' },
  { value: 'incident_created', label: 'Incident opened or still failing', hint: 'Incident lifecycle updates.' },
  { value: 'incident_acknowledged', label: 'Incident acknowledged', hint: 'Somebody picked up the incident.' },
  { value: 'incident_resolved', label: 'Incident resolved', hint: 'The outage is over.' },
];

export default function Settings() {
  const toast = useToast();
  const { user, refresh } = useAuth();
  const { isDark, toggle } = useTheme();
  const { setUnreadCount } = useRealtime();

  const load = useCallback(() => settingsApi.get(), []);
  const { data, loading, error, reload } = useAsync(load, [load]);

  const [profile, setProfile] = useState({ name: '', email: '' });
  const [profileErrors, setProfileErrors] = useState({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordErrors, setPasswordErrors] = useState({});
  const [savingPassword, setSavingPassword] = useState(false);

  const [prefs, setPrefs] = useState({
    inAppEnabled: true,
    emailEnabled: false,
    emailTypes: ['monitor_down', 'monitor_recovered', 'incident_created', 'incident_resolved'],
  });
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!data) return;
    setProfile({ name: data.user.name, email: data.user.email });
    setPrefs(data.preferences);
    setTestTo(data.user.email);
  }, [data]);

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfileErrors({});
    setSavingProfile(true);
    try {
      await authApi.updateProfile(profile);
      await refresh();
      toast.success('Profile updated.');
    } catch (err) {
      setProfileErrors(err.fieldErrors ?? {});
      toast.error(err.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setPasswordErrors({});

    if (password.newPassword !== password.confirmPassword) {
      setPasswordErrors({ confirmPassword: 'Passwords do not match' });
      return;
    }

    setSavingPassword(true);
    try {
      await authApi.changePassword({
        currentPassword: password.currentPassword,
        newPassword: password.newPassword,
      });
      setPassword({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password changed.');
    } catch (err) {
      setPasswordErrors(err.fieldErrors ?? {});
      toast.error(err.message);
    } finally {
      setSavingPassword(false);
    }
  };

  const toggleType = (type) => {
    setPrefs((p) => ({
      ...p,
      emailTypes: p.emailTypes.includes(type)
        ? p.emailTypes.filter((t) => t !== type)
        : [...p.emailTypes, type],
    }));
  };

  const savePrefs = async (e) => {
    e.preventDefault();
    if (prefs.emailEnabled && prefs.emailTypes.length === 0) {
      toast.error('Pick at least one alert type for email, or turn email alerts off.');
      return;
    }
    setSavingPrefs(true);
    try {
      const result = await settingsApi.updatePreferences(prefs);
      setPrefs(result.preferences);
      toast.success('Preferences saved.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingPrefs(false);
    }
  };

  const testEmail = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await settingsApi.testEmail(testTo);
      setTestResult({ ok: true, message: result.message });
      toast.success(result.message);
    } catch (err) {
      // The API reports the real reason (SMTP not configured, auth failed…)
      setTestResult({ ok: false, message: err.message });
      toast.error(err.message);
    } finally {
      setTesting(false);
    }
  };

  const clearNotifications = async () => {
    setClearing(true);
    try {
      const result = await settingsApi.clearNotifications();
      toast.success(result.message);
      setUnreadCount(0);
      setConfirmClear(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setClearing(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading your settings…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const smtp = data.capabilities;

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">
            Signed in as {user?.email} · member since{' '}
            {data.user.createdAt ? new Date(data.user.createdAt).toLocaleDateString() : '—'}
          </p>
        </div>
      </header>

      {!smtp.smtpConfigured && (
        <DataNote title="Email alerts:">
          Not enabled on this server, so alerts only appear in the notification centre. Ask whoever
          runs this instance to set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{' '}
          <code>SMTP_USER</code> and <code>SMTP_PASS</code> and restart the backend.
        </DataNote>
      )}

      <Card>
        <CardHead title="Profile" subtitle="How your name appears to the rest of the team" />
        <form onSubmit={saveProfile} className="stack">
          <div className="grid grid-2">
            <Field label="Full name" htmlFor="settings-name" error={profileErrors.name} required>
              <input
                id="settings-name"
                className="input"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                minLength={2}
                required
                aria-invalid={Boolean(profileErrors.name)}
              />
            </Field>
            <Field label="Email address" htmlFor="settings-email" error={profileErrors.email} required>
              <input
                id="settings-email"
                type="email"
                className="input"
                value={profile.email}
                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))}
                required
                aria-invalid={Boolean(profileErrors.email)}
              />
            </Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={savingProfile}>
              {savingProfile && <span className="spinner" aria-hidden="true" />}
              Save profile
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHead title="Password" subtitle="At least 8 characters with a letter and a number" />
        <form onSubmit={savePassword} className="stack">
          <div className="grid grid-2">
            <Field
              label="Current password"
              htmlFor="current-password"
              error={passwordErrors.currentPassword}
              required
            >
              <input
                id="current-password"
                type="password"
                className="input"
                value={password.currentPassword}
                onChange={(e) => setPassword((p) => ({ ...p, currentPassword: e.target.value }))}
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label="New password" htmlFor="new-password" error={passwordErrors.newPassword} required>
              <input
                id="new-password"
                type="password"
                className="input"
                value={password.newPassword}
                onChange={(e) => setPassword((p) => ({ ...p, newPassword: e.target.value }))}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
          </div>
          <Field
            label="Confirm new password"
            htmlFor="confirm-password"
            error={passwordErrors.confirmPassword}
            required
          >
            <input
              id="confirm-password"
              type="password"
              className="input"
              value={password.confirmPassword}
              onChange={(e) => setPassword((p) => ({ ...p, confirmPassword: e.target.value }))}
              autoComplete="new-password"
              required
            />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={savingPassword}>
              {savingPassword && <span className="spinner" aria-hidden="true" />}
              Change password
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHead
          title="Alerts"
          subtitle="Choose what OpsPulse tells you about, and where"
        />
        <form onSubmit={savePrefs} className="stack">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={prefs.inAppEnabled}
              onChange={(e) => setPrefs((p) => ({ ...p, inAppEnabled: e.target.checked }))}
            />
            <span>
              <strong>In-app notifications</strong>
              <br />
              <span className="hint">Show alerts in the notification centre and the bell icon.</span>
            </span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={prefs.emailEnabled}
              onChange={(e) => setPrefs((p) => ({ ...p, emailEnabled: e.target.checked }))}
              disabled={!smtp.smtpConfigured}
            />
            <span>
              <strong>Email notifications</strong>
              <br />
              <span className="hint">
                {smtp.smtpConfigured
                  ? `Sent from ${smtp.smtpFrom} using ${smtp.smtpHost}.`
                  : 'Unavailable — SMTP is not configured on this server.'}
              </span>
            </span>
          </label>

          <fieldset
            style={{ border: 'none', padding: 0, margin: 0 }}
            disabled={!prefs.emailEnabled}
          >
            <legend className="label" style={{ marginBottom: 'var(--sp-2)' }}>
              Send email for
            </legend>
            <div className="stack-sm">
              {ALERT_TYPES.map((type) => (
                <label className="checkbox-row" key={type.value}>
                  <input
                    type="checkbox"
                    checked={prefs.emailTypes.includes(type.value)}
                    onChange={() => toggleType(type.value)}
                  />
                  <span>
                    <strong>{type.label}</strong>
                    <br />
                    <span className="hint">{type.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={savingPrefs}>
              {savingPrefs && <span className="spinner" aria-hidden="true" />}
              Save preferences
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHead
          title="Test email"
          subtitle="Sends a real message and reports exactly what happened"
        />
        <div className="stack">
          <div className="row">
            <div className="grow">
              <Field label="Send a test to" htmlFor="test-email-to">
                <input
                  id="test-email-to"
                  type="email"
                  className="input"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@example.com"
                />
              </Field>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={testEmail}
              disabled={testing || !testTo}
              style={{ marginTop: 'var(--sp-5)' }}
            >
              {testing && <span className="spinner" aria-hidden="true" />}
              Send test email
            </button>
          </div>

          {testResult && (
            <Alert type={testResult.ok ? 'success' : 'error'}>{testResult.message}</Alert>
          )}

          {smtp.smtpConfigured && (
            <p className="hint">
              Server SMTP account: {smtp.smtpUser} on {smtp.smtpHost}. The password is never shown.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHead title="Appearance" />
        <div className="row-between">
          <div>
            <strong>{isDark ? 'Dark' : 'Light'} theme</strong>
            <div className="hint">Your choice is saved in this browser.</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={toggle}>
            Switch to {isDark ? 'light' : 'dark'}
          </button>
        </div>
      </Card>

      <Card>
        <CardHead
          title="Notification history"
          subtitle="Delete every notification stored for your account"
        />
        <div className="row-between">
          <div className="hint">
            This does not delete incidents or check history — only your notifications.
          </div>
          <button type="button" className="btn btn-danger" onClick={() => setConfirmClear(true)}>
            Delete all notifications
          </button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmClear}
        title="Delete all notifications?"
        message="Every notification stored for your account will be permanently removed. This cannot be undone."
        confirmLabel="Delete all"
        busy={clearing}
        onConfirm={clearNotifications}
        onClose={() => setConfirmClear(false)}
      />
    </div>
  );
}