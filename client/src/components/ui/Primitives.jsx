/** Small presentational primitives shared by every page. */

export function Card({ children, className = '', ...rest }) {
  return (
    <section className={`card ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function CardHead({ title, subtitle, actions }) {
  return (
    <header className="card-head">
      <div>
        <h2 className="card-title">{title}</h2>
        {subtitle && <div className="card-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

/** One dashboard number. `tone` colours the left rail. */
export function Stat({ label, value, hint, tone = 'brand', icon }) {
  const color =
    { brand: 'var(--brand-500)', up: 'var(--up)', down: 'var(--down)', degraded: 'var(--degraded)', paused: 'var(--paused)' }[
      tone
    ] || 'var(--brand-500)';

  return (
    <div className="stat" style={{ '--accent': color }}>
      <span className="stat-label">
        {icon && <span aria-hidden="true">{icon} </span>}
        {label}
      </span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Field({ label, htmlFor, hint, error, required, children }) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <span className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </span>
      ) : (
        hint && <span className="hint">{hint}</span>
      )}
    </div>
  );
}

export function Alert({ type = 'info', children }) {
  const icon = { info: 'i', error: '!', success: '✓' }[type] ?? 'i';
  return (
    <div className={`alert alert-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true" style={{ fontWeight: 700 }}>
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Pagination({ meta, onChange }) {
  if (!meta || meta.total === 0) return null;
  const { page, totalPages, total, limit } = meta;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <nav className="pagination" aria-label="Pagination">
      <span>
        Showing <strong>{from}</strong>–<strong>{to}</strong> of <strong>{total}</strong>
      </span>
      <div className="row">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onChange(page - 1)}
          disabled={!meta.hasPrevPage}
        >
          Previous
        </button>
        <span>
          Page {page} of {Math.max(totalPages, 1)}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onChange(page + 1)}
          disabled={!meta.hasNextPage}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

export function DefinitionList({ items }) {
  return (
    <dl className="kv">
      {items.map(({ label, value }) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}