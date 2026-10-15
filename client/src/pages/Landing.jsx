import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

const FEATURES = [
  {
    icon: '◉',
    title: 'Real HTTP checks',
    body: 'Every status, response time and error on this page comes from an actual request your OpsPulse server made — never from sample data.',
  },
  {
    icon: '⏱',
    title: 'Response-time analytics',
    body: 'Average, p50, p95 and p99 latency per monitor, with gaps drawn honestly where no check was recorded.',
  },
  {
    icon: '◔',
    title: 'Uptime you can trust',
    body: 'Uptime is calculated from persisted check rows. Missing checks are counted as unknown, never as success.',
  },
  {
    icon: '⛨',
    title: 'SSRF-safe by design',
    body: 'Private IP ranges, cloud metadata endpoints and localhost are blocked, and every redirect is re-validated.',
  },
  {
    icon: '⌂',
    title: 'Team workspaces',
    body: 'Owner, admin and viewer roles keep each workspace isolated — members only ever see their own monitors.',
  },
  {
    icon: '◐',
    title: 'Light and dark',
    body: 'A dashboard that is easy on the eyes during an incident at 2 a.m. and readable in daylight.',
  },
];

export default function Landing() {
  const { isAuthenticated } = useAuth();
  const { isDark, toggle } = useTheme();

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="row">
          <span className="brand-mark" aria-hidden="true">
            OP
          </span>
          <span className="brand-name">OpsPulse</span>
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggle}
            aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
          >
            {isDark ? '☀ Light' : '☾ Dark'}
          </button>
          {isAuthenticated ? (
            <Link to="/app" className="btn btn-primary btn-sm">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className="btn btn-secondary btn-sm">
                Sign in
              </Link>
              <Link to="/register" className="btn btn-primary btn-sm">
                Get started
              </Link>
            </>
          )}
        </div>
      </header>

      <section className="landing-hero">
        <h1>
          Know your site is down
          <br />
          before your users tell you.
        </h1>
        <p className="lead">
          OpsPulse checks your websites and APIs on a schedule, records every response, and shows you
          uptime, latency and outages from real data — not from a demo.
        </p>
        <div className="row">
          {isAuthenticated ? (
            <Link to="/app" className="btn btn-primary btn-lg">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link to="/register" className="btn btn-primary btn-lg">
                Create free workspace
              </Link>
              <Link to="/login" className="btn btn-secondary btn-lg">
                I already have an account
              </Link>
            </>
          )}
        </div>
        <p style={{ marginTop: 'var(--sp-5)', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
          Self-hosted · Docker ready · Your data stays in your own MongoDB
        </p>
      </section>

      <div className="feature-grid">
        {FEATURES.map((feature) => (
          <article className="feature" key={feature.title}>
            <div className="feature-icon" aria-hidden="true">
              {feature.icon}
            </div>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </div>

      <footer className="landing-foot">
        <p>OpsPulse — React · Node.js · Express · MongoDB · Socket.IO · Docker</p>
      </footer>
    </div>
  );
}