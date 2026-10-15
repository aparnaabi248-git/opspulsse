/** Shared status vocabulary for monitors and checks. */

export const MONITOR_STATUSES = ['up', 'down', 'degraded', 'paused', 'pending'];

export const STATUS_META = {
  up: { label: 'Up', color: 'var(--up)', tone: 'up' },
  down: { label: 'Down', color: 'var(--down)', tone: 'down' },
  degraded: { label: 'Degraded', color: 'var(--degraded)', tone: 'degraded' },
  paused: { label: 'Paused', color: 'var(--paused)', tone: 'paused' },
  pending: { label: 'Pending', color: 'var(--pending)', tone: 'pending' },
};

export const statusMeta = (status) =>
  STATUS_META[status] || { label: status || 'Unknown', color: 'var(--paused)', tone: 'paused' };

/** Chart colours, resolved to CSS variables by the browser. */
export const CHART_COLORS = {
  up: '#22c55e',
  down: '#ef4444',
  degraded: '#f59e0b',
  paused: '#64748b',
  pending: '#a855f7',
  brand: '#6366f1',
};

export const RANGE_OPTIONS = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];