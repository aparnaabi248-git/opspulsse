import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ToastProvider } from '../components/ui/ToastProvider';
import { tokenStore } from '../api/client';

/**
 * Regression tests for a bug that made pages "fail to load".
 *
 * The auth refresh used to treat ANY failure of GET /api/auth/me as "your
 * session is over". So a 429 rate limit (or a 5xx, or being briefly offline)
 * silently deleted the JWT and bounced the user to the login screen — which
 * looked like the page could not load.
 */

vi.mock('../api', () => ({ authApi: { me: vi.fn(), logout: vi.fn() } }));
import { authApi } from '../api';

function Probe() {
  const { isAuthenticated, user, loading } = useAuth();
  if (loading) return <p>checking session…</p>;
  return (
    <div>
      <p data-testid="auth-state">{isAuthenticated ? `signed in as ${user?.email}` : 'signed out'}</p>
    </div>
  );
}

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={['/app']}>
      <AuthProvider>
        <Routes>
          <Route path="/app" element={<Probe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );

describe('AuthContext session handling', () => {
  beforeEach(() => {
    authApi.me.mockReset();
  });

  afterEach(() => {
    tokenStore.set(null);
  });

  it('restores the session when /auth/me succeeds', async () => {
    tokenStore.set('valid-token');
    authApi.me.mockResolvedValue({
      user: { id: 'u1', name: 'Arun', email: 'arun@example.com' },
      teams: [{ _id: 't1', name: 'Team', role: 'owner' }],
    });

    renderApp();

    expect(await screen.findByText('signed in as arun@example.com')).toBeInTheDocument();
    expect(tokenStore.get()).toBe('valid-token');
  });

  it('KEEPS the session when /auth/me is rate limited (429)', async () => {
    tokenStore.set('valid-token');
    authApi.me.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));

    renderApp();

    await waitFor(() => expect(screen.queryByText('checking session…')).not.toBeInTheDocument());
    expect(tokenStore.get()).toBe('valid-token');
  });

  it('KEEPS the session when the server has a problem (500)', async () => {
    tokenStore.set('valid-token');
    authApi.me.mockRejectedValue(Object.assign(new Error('Server exploded'), { status: 500 }));

    renderApp();

    await waitFor(() => expect(screen.queryByText('checking session…')).not.toBeInTheDocument());
    expect(tokenStore.get()).toBe('valid-token');
  });

  it('KEEPS the session when the network is unreachable (no status)', async () => {
    tokenStore.set('valid-token');
    authApi.me.mockRejectedValue(new Error('Network Error'));

    renderApp();

    await waitFor(() => expect(screen.queryByText('checking session…')).not.toBeInTheDocument());
    expect(tokenStore.get()).toBe('valid-token');
  });

  it('clears the session on a real 401', async () => {
    tokenStore.set('expired-token');
    authApi.me.mockRejectedValue(Object.assign(new Error('Invalid authentication token'), { status: 401 }));

    renderApp();

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(tokenStore.get()).toBeNull();
  });

  it('shows the sign-out state when there was never a token', async () => {
    tokenStore.set(null);
    authApi.me.mockResolvedValue({ user: null, teams: [] });

    renderApp();

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(authApi.me).not.toHaveBeenCalled();
  });
});

describe('Login form error handling', () => {
  it('explains a rate limit in plain language instead of a raw message', async () => {
    const user = userEvent.setup();
    authApi.me.mockReset();

    const AuthForm = (await import('../pages/AuthForm')).default;
    const { authApi: realAuthApi } = await import('../api');
    realAuthApi.login = vi.fn().mockRejectedValue(
      Object.assign(new Error('Too many failed sign-in attempts.'), { status: 429 })
    );

    render(
      <MemoryRouter>
        <ToastProvider>
          <AuthProvider>
            <AuthForm mode="login" />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByLabelText(/Email address/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Email address/), 'a@b.com');
    await user.type(screen.getByLabelText(/^Password/), 'Password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText(/Too many sign-in attempts from this network/i)
    ).toBeInTheDocument();
  });
});