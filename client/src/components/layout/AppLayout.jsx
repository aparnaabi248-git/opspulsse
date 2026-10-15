import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useRealtime } from '../../context/RealtimeContext';
import { useTheme } from '../../context/ThemeContext';
import { initials } from '../../utils/format';

/**
 * Application shell: sidebar + topbar + routed page.
 *
 * The sidebar only lists pages that actually exist. There are no dead links
 * anywhere in this app.
 */

const NAV_SECTIONS = [
  {
    title: 'Monitor',
    items: [
      { to: '/app', label: 'Dashboard', icon: '◧', end: true },
      { to: '/app/monitors', label: 'Monitors', icon: '◉' },
      { to: '/app/analytics', label: 'Analytics', icon: '◔' },
      { to: '/app/reports', label: 'Reports', icon: '▤' },
    ],
  },
  {
    title: 'Respond',
    items: [
      { to: '/app/incidents', label: 'Incidents', icon: '⚠' },
      { to: '/app/notifications', label: 'Notifications', icon: '🔔', badge: true },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { to: '/app/team', label: 'Team', icon: '⌂' },
      { to: '/app/settings', label: 'Settings', icon: '⚙' },
    ],
  },
];

function Sidebar({ open, onNavigate }) {
  const { user, teams, activeTeamId, setActiveTeamId } = useAuth();
  const { unreadCount } = useRealtime();

  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Main navigation">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          OP
        </span>
        <span className="brand-name">OpsPulse</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="nav-section">{section.title}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="grow">{item.label}</span>
                {item.badge && unreadCount > 0 && (
                  <span className="badge down" aria-label={`${unreadCount} unread`}>
                    {unreadCount}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}

        {teams.length > 0 && (
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <div className="nav-section">Workspace</div>
            <div className="field">
              <label className="visually-hidden" htmlFor="team-switcher">
                Active workspace
              </label>
              <select
                id="team-switcher"
                className="select"
                value={activeTeamId ?? ''}
                onChange={(e) => setActiveTeamId(e.target.value)}
              >
                {teams.map((team) => (
                  <option key={team._id ?? team.id} value={String(team._id ?? team.id)}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </nav>

      <div className="sidebar-foot">
        <div className="row">
          <span className="avatar" aria-hidden="true">
            {initials(user?.name)}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{user?.name}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {user?.email}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const { logout } = useAuth();
  const { isDark, toggle } = useTheme();
  const { status: socketStatus, isLive } = useRealtime();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const liveLabel =
    socketStatus === 'connected'
      ? 'Live updates connected'
      : socketStatus === 'error'
        ? 'Live updates unavailable'
        : 'Connecting to live updates…';

  return (
    <div className="app-shell">
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      {navOpen && (
        <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="hamburger"
            onClick={() => setNavOpen((v) => !v)}
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
          >
            ☰
          </button>

          <span
            className="badge"
            title={liveLabel}
            style={{
              background: isLive ? 'var(--up-soft)' : 'var(--paused-soft)',
              color: isLive ? 'var(--up)' : 'var(--paused)',
            }}
          >
            <span className={`dot${isLive ? ' pulse' : ''}`} aria-hidden="true" />
            {isLive ? 'Live' : 'Offline'}
          </span>

          <div className="grow" />

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggle}
            aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
            title={`Switch to ${isDark ? 'light' : 'dark'} theme`}
          >
            {isDark ? '☀' : '☾'}
          </button>

          <button type="button" className="btn btn-secondary btn-sm" onClick={handleLogout}>
            Sign out
          </button>
        </header>

        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}