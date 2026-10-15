import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { notificationsApi } from '../api';
import { useAsync, useNow } from '../hooks/useAsync';
import { useLiveRefresh, useRealtime } from '../context/RealtimeContext';
import { useToast } from '../components/ui/ToastProvider';
import { Card, Alert, Pagination } from '../components/ui/Primitives';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/EmptyState';
import { formatDateTime, formatRelative } from '../utils/format';

const TYPE_META = {
  monitor_down: { label: 'Monitor down', tone: 'down' },
  monitor_recovered: { label: 'Recovered', tone: 'up' },
  monitor_degraded: { label: 'Degraded', tone: 'degraded' },
  incident_created: { label: 'Incident opened', tone: 'down' },
  incident_acknowledged: { label: 'Acknowledged', tone: 'degraded' },
  incident_resolved: { label: 'Incident resolved', tone: 'up' },
  info: { label: 'Info', tone: 'paused' },
};

export default function Notifications() {
  const toast = useToast();
  const now = useNow(20_000);
  const { unreadCount, setUnreadCount, status: socketStatus } = useRealtime();

  const [searchParams, setSearchParams] = useSearchParams();
  const unread = searchParams.get('unread') === 'true';
  const page = Number(searchParams.get('page') ?? 1);

  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (!value) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(
    () => notificationsApi.list({ unread: unread ? 'true' : undefined, page, limit: 25 }),
    [unread, page]
  );

  const { data, loading, error, reload } = useAsync(load, [load]);
  const emailStatus = useAsync(() => notificationsApi.emailStatus(), []);

  const notifications = data?.notifications ?? [];

  useLiveRefresh(reload, ['notification:new', 'notification:read']);

  const markAsRead = async (notification) => {
    if (notification.read) return;
    try {
      const result = await notificationsApi.markAsRead(notification._id);
      setUnreadCount(result.unreadCount);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const markAll = async () => {
    setBusy(true);
    try {
      const result = await notificationsApi.markAllAsRead();
      toast.success(result.message);
      setUnreadCount(0);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setBusy(true);
    try {
      const result = await notificationsApi.remove(target._id);
      setUnreadCount(result.unreadCount);
      toast.success('Notification deleted.');
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            Notifications{' '}
            {data?.unreadCount > 0 && <span className="badge down">{data.unreadCount} unread</span>}
          </h1>
          <p className="subtitle">
            Alerts are pushed live while you are signed in
            {socketStatus === 'connected' ? ' · connected' : ' · reconnecting…'}
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={reload}>
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={markAll}
            disabled={busy || (data?.unreadCount ?? 0) === 0}
          >
            Mark all as read
          </button>
        </div>
      </header>

      <Card className="card-tight">
        <div className="row">
          <div className="chip-row" role="group" aria-label="Filter notifications">
            <button
              type="button"
              className={`chip${!unread ? ' active' : ''}`}
              onClick={() => setParam('unread', null)}
            >
              All
            </button>
            <button
              type="button"
              className={`chip${unread ? ' active' : ''}`}
              onClick={() => setParam('unread', 'true')}
            >
              Unread {data?.unreadCount ? `(${data.unreadCount})` : ''}
            </button>
          </div>

          {emailStatus.data && !emailStatus.data.emailConfigured && (
            <span className="hint">Email alerts are not enabled for this server.</span>
          )}
        </div>
      </Card>

      {loading && !data ? (
        <LoadingState label="Loading notifications…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : notifications.length === 0 ? (
        <Card>
          <EmptyState
            icon="🔔"
            title={unread ? 'Nothing unread' : 'No notifications yet'}
            message={
              unread
                ? 'You are all caught up. Switch to "All" to see your history.'
                : 'When a monitor goes down or recovers you will get an alert here — instantly, without refreshing.'
            }
            actionLabel={unread ? 'Show all' : undefined}
            onAction={unread ? () => setParam('unread', null) : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="stack-sm">
            {notifications.map((notification) => {
              const meta = TYPE_META[notification.type] ?? { label: notification.type, tone: 'paused' };
              return (
                <div
                  key={notification._id}
                  className="card card-tight"
                  style={{
                    borderLeft: `3px solid ${
                      notification.read ? 'var(--border)' : 'var(--brand-500)'
                    }`,
                  }}
                >
                  <div className="row-between">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row" style={{ gap: 'var(--sp-2)' }}>
                        {!notification.read && (
                          <span
                            className="dot pulse"
                            style={{ background: 'var(--brand-500)', color: 'var(--brand-500)' }}
                            aria-label="Unread"
                          />
                        )}
                        <strong style={{ fontSize: 'var(--text-sm)' }}>{notification.title}</strong>
                        <span className={`badge ${meta.tone}`}>{meta.label}</span>
                      </div>
                      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
                        {notification.message}
                      </p>
                      <div className="row" style={{ gap: 'var(--sp-3)', marginTop: 6 }}>
                        <span className="timeline-time" title={formatDateTime(notification.createdAt)}>
                          {formatRelative(notification.createdAt, now)}
                        </span>
                        {notification.monitor && (
                          <Link to={`/app/monitors/${notification.monitor}`} className="timeline-time">
                            View monitor →
                          </Link>
                        )}
                        {notification.incident && (
                          <Link to={`/app/incidents/${notification.incident}`} className="timeline-time">
                            View incident →
                          </Link>
                        )}
                        {notification.email?.status === 'skipped_not_configured' && (
                          <span className="timeline-time">email not sent (SMTP off)</span>
                        )}
                        {notification.email?.status === 'failed' && (
                          <span className="timeline-time" style={{ color: 'var(--down)' }}>
                            email failed
                          </span>
                        )}
                        {notification.email?.status === 'sent' && (
                          <span className="timeline-time">email sent</span>
                        )}
                      </div>
                    </div>

                    <div className="row-actions">
                      {!notification.read && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => markAsRead(notification)}
                        >
                          Mark read
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--down)' }}
                        onClick={() => setPendingDelete(notification)}
                        aria-label={`Delete notification: ${notification.title}`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <Pagination meta={data.pagination} onChange={(p) => setParam('page', String(p))} />
        </>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this notification?"
        message="It will be removed permanently from your notification history."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />

      {unreadCount > 0 && unreadCount !== data?.unreadCount && (
        <span className="visually-hidden" role="status">
          {unreadCount} unread notifications
        </span>
      )}
    </div>
  );
}