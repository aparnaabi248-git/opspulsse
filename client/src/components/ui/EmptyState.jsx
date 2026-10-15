import { Link } from 'react-router-dom';

/** Consistent empty state for every list and chart in the app. */
export function EmptyState({ icon = '◍', title, message, actionLabel, actionTo, onAction }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {actionLabel &&
        (actionTo ? (
          <Link to={actionTo} className="btn btn-primary">
            {actionLabel}
          </Link>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onAction}>
            {actionLabel}
          </button>
        ))}
    </div>
  );
}

export default EmptyState;

/** Full-page loading state. */
export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="center-load">
      <div className="spinner lg" aria-hidden="true" />
      <p role="status">{label}</p>
    </div>
  );
}

/** Error state with a retry button. */
export function ErrorState({ error, onRetry }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true" style={{ color: 'var(--down)' }}>
        !
      </div>
      <h3>Could not load this page</h3>
      <p>{error?.message || 'An unexpected error occurred.'}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}