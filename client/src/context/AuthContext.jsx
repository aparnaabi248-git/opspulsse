import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api';
import { tokenStore, onUnauthorized } from '../api/client';

/**
 * Auth state.
 * The JWT is kept in localStorage (so a page refresh keeps you signed in)
 * AND the API sets an httpOnly cookie, so either mechanism works.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [teams, setTeams] = useState([]);
  const [activeTeamId, setActiveTeamId] = useState(null);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((data) => {
    tokenStore.set(data.token ?? tokenStore.get());
    setUser(data.user);
    setTeams(data.teams ?? []);
    setActiveTeamId((current) => {
      const ids = (data.teams ?? []).map((t) => String(t._id ?? t.id));
      return current && ids.includes(String(current)) ? current : ids[0] ?? null;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await authApi.me();
      setUser(data.user);
      setTeams(data.teams ?? []);
      setActiveTeamId((current) => {
        const ids = (data.teams ?? []).map((t) => String(t._id ?? t.id));
        return current && ids.includes(String(current)) ? current : ids[0] ?? null;
      });
      return data;
    } catch (err) {
      // Only a genuine "your session is no longer valid" response may log the
      // user out. A rate limit (429), a server hiccup (5xx) or an offline
      // network must NOT throw away a valid token — that used to bounce people
      // to the login screen with no explanation.
      const status = err?.status;
      const sessionGone = status === 401 || status === 403;

      if (sessionGone) {
        tokenStore.set(null);
        setUser(null);
        setTeams([]);
        return null;
      }

      // Keep whatever we already had; the UI can show an error banner instead
      if (status === 429 || status >= 500 || status === undefined) {
        console.warn('Could not refresh the session, keeping the current one:', err?.message);
        return null;
      }

      tokenStore.set(null);
      setUser(null);
      setTeams([]);
      return null;
    }
  }, []);

  // On mount: if we hold a token, validate it against the API.
  // A failed validation must NOT log the user out (see refresh above).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (tokenStore.get()) {
        try {
          await refresh();
        } catch {
          /* handled inside refresh */
        }
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // A 401 from anywhere means the session is gone
  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setTeams([]);
      }),
    []
  );

  const login = useCallback(
    async (credentials) => {
      const data = await authApi.login(credentials);
      applySession({ ...data, token: data.token });
      // /login returns teams, /register does too
      if (data.teams) setTeams(data.teams);
      return data;
    },
    [applySession]
  );

  const register = useCallback(
    async (payload) => {
      const data = await authApi.register(payload);
      applySession({ ...data, token: data.token, teams: data.team ? [data.team] : [] });
      return data;
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      tokenStore.set(null);
      setUser(null);
      setTeams([]);
      setActiveTeamId(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      teams,
      activeTeamId,
      setActiveTeamId,
      loading,
      login,
      register,
      logout,
      refresh,
      isAuthenticated: Boolean(user),
    }),
    [user, teams, activeTeamId, loading, login, register, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The caller's role in the currently selected team. */
export function useActiveTeam() {
  const { teams, activeTeamId } = useAuth();
  const team = teams.find((t) => String(t._id ?? t.id) === String(activeTeamId)) ?? teams[0] ?? null;
  return {
    team,
    teamId: team ? String(team._id ?? team.id) : null,
    role: team?.role ?? 'owner',
    canManage: team ? ['owner', 'admin'].includes(team.role) : true,
  };
}