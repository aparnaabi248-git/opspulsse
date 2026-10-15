import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/ui/ToastProvider';
import { Field, Alert } from '../components/ui/Primitives';

/** Login / Register share one layout. */
export default function AuthForm({ mode = 'login' }) {
  const isRegister = mode === 'register';
  const { login, register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setFieldErrors((f) => ({ ...f, [key]: undefined }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});

    if (isRegister && form.password !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: 'Passwords do not match' });
      return;
    }

    setBusy(true);
    try {
      if (isRegister) {
        await register({ name: form.name, email: form.email, password: form.password });
        toast.success('Account created. Your personal workspace is ready.');
      } else {
        await login({ email: form.email, password: form.password });
        toast.success('Signed in.');
      }
      navigate(location.state?.from ?? '/app', { replace: true });
    } catch (err) {
      setFieldErrors(err.fieldErrors ?? {});
      setFormError(
        err.status === 429
          ? 'Too many sign-in attempts from this network. Please wait a few minutes and try again.'
          : err.message
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            OP
          </span>
          <span className="brand-name">OpsPulse</span>
        </div>

        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--sp-2)' }}>
          {isRegister ? 'Create your workspace' : 'Sign in to OpsPulse'}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 'var(--sp-5)' }}>
          {isRegister
            ? 'One account gives you a personal workspace straight away. You can invite your team later.'
            : 'Welcome back. Enter your credentials to continue.'}
        </p>

        {formError && (
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <Alert type="error">{formError}</Alert>
          </div>
        )}

        <form onSubmit={onSubmit} className="stack" noValidate>
          {isRegister && (
            <Field label="Full name" htmlFor="name" error={fieldErrors.name} required>
              <input
                id="name"
                name="name"
                className="input"
                value={form.name}
                onChange={update('name')}
                autoComplete="name"
                required
                minLength={2}
                aria-invalid={Boolean(fieldErrors.name)}
              />
            </Field>
          )}

          <Field label="Email address" htmlFor="email" error={fieldErrors.email} required>
            <input
              id="email"
              name="email"
              type="email"
              className="input"
              value={form.email}
              onChange={update('email')}
              autoComplete="email"
              required
              aria-invalid={Boolean(fieldErrors.email)}
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            error={fieldErrors.password}
            hint={isRegister ? 'At least 8 characters, with a letter and a number' : undefined}
            required
          >
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              value={form.password}
              onChange={update('password')}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              aria-invalid={Boolean(fieldErrors.password)}
            />
          </Field>

          {isRegister && (
            <Field label="Confirm password" htmlFor="confirmPassword" error={fieldErrors.confirmPassword} required>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                className="input"
                value={form.confirmPassword}
                onChange={update('confirmPassword')}
                autoComplete="new-password"
                required
                aria-invalid={Boolean(fieldErrors.confirmPassword)}
              />
            </Field>
          )}

          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          ) : (
            <>
              New to OpsPulse? <Link to="/register">Create an account</Link>
            </>
          )}
        </p>

        <p className="auth-switch">
          <Link to="/">← Back to home</Link>
        </p>
      </div>
    </div>
  );
}