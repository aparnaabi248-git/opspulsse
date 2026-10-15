import { statusMeta } from '../../utils/status';

/** Coloured status pill used in tables, cards and detail pages. */
export default function StatusBadge({ status, pulse = false, showDot = true }) {
  const meta = statusMeta(status);

  return (
    <span className={`badge ${meta.tone}`} title={`Status: ${meta.label}`}>
      {showDot && <span className={`dot${pulse ? ' pulse' : ''}`} aria-hidden="true" />}
      {meta.label}
    </span>
  );
}