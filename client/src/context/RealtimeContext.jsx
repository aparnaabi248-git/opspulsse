import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { notificationsApi } from '../api';
import {
  connectSocket,
  disconnectSocket,
  onSocketEvent,
  useSocketEvent,
  useSocketStatus,
} from '../socket/client';
import { useAuth } from './AuthContext';
import { useToast } from '../components/ui/ToastProvider';

/**
 * RealtimeContext
 * ===============
 * Connects the app to the live event stream and exposes:
 *   - connectionStatus      offline | connecting | connected | error
 *   - unreadCount           live badge number
 *   - lastEventAt           when something last arrived
 *
 * Pages subscribe to this context to know when to refresh. That keeps the
 * socket logic in one place instead of scattering listeners everywhere.
 */

const RealtimeContext = createContext(null);

export function RealtimeProvider({ children }) {
  const { isAuthenticated, user } = useAuth();
  const toast = useToast();

  const [unreadCount, setUnreadCount] = useState(0);
  const [lastEventAt, setLastEventAt] = useState(null);
  const status = useSocketStatus();

  // Open one socket per signed-in session
  useEffect(() => {
    if (!isAuthenticated) {
      disconnectSocket();
      setUnreadCount(0);
      return undefined;
    }

    connectSocket();

    return () => {
      // Do not disconnect on unmount: StrictMode remounts would thrash it.
      // disconnect happens on logout (see below).
    };
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    if (!isAuthenticated) disconnectSocket();
  }, [isAuthenticated]);

  // Seed the badge from the server, so a page reload shows the real count
  // instead of waiting for the next live alert to arrive.
  useEffect(() => {
    if (!isAuthenticated) return undefined;

    let cancelled = false;
    notificationsApi
      .unreadCount()
      .then((data) => {
        if (!cancelled) setUnreadCount(data.unreadCount ?? 0);
      })
      .catch(() => {
        /* the badge is cosmetic — a failure here must not break the app */
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // ── Live unread badge ─────────────────────────────────────────────
  useSocketEvent('notification:new', (payload) => {
    setUnreadCount((count) => count + 1);
    setLastEventAt(new Date().toISOString());
    if (payload?.severity === 'critical') toast.error(`${payload.title} — ${payload.message}`);
    else toast.info(`${payload.title} — ${payload.message}`);
  });

  useSocketEvent('notification:read', (payload) => {
    if (typeof payload?.unreadCount === 'number') setUnreadCount(payload.unreadCount);
  });

  useSocketEvent('monitor:status', () => setLastEventAt(new Date().toISOString()));

  const value = useMemo(
    () => ({
      status,
      isLive: status === 'connected',
      unreadCount,
      setUnreadCount,
      lastEventAt,
    }),
    [status, unreadCount, lastEventAt]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return ctx;
}

/**
 * Refresh the current page's data whenever a relevant event arrives.
 *
 *   useLiveRefresh(reload, ['monitor:status', 'monitor:check', 'incident:changed']);
 */
export function useLiveRefresh(handler, events = ['monitor:status', 'monitor:check']) {
  const saved = useRef(handler);
  saved.current = handler;

  // One effect for a variable number of events keeps the hooks rules happy
  const key = events.join('|');

  useEffect(() => {
    const names = key.split('|').filter(Boolean);
    const wrapped = () => saved.current();
    const cleanups = names.map((name) => onSocketEvent(name, wrapped));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [key]);
}