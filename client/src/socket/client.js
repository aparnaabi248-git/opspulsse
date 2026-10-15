import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { tokenStore } from '../api/client';

const SOCKET_URL = import.meta.env.VITE_API_BASE_URL || '';

/**
 * Socket.IO connection
 * ====================
 * One shared connection for the whole app, created only while a user is
 * signed in. The JWT is sent in the handshake, so the server can reject an
 * unauthenticated socket before any event is delivered.
 *
 * The server only ever pushes events for the teams this user belongs to.
 */

let socket = null;
const listeners = new Map();
let statusListeners = new Set();

// The last known status lives at module scope so a component that mounts
// before (or after) the socket was created still reports the truth.
let currentStatus = 'offline';

export const connectSocket = () => {
  if (socket?.connected || socket) return socket;

  socket = io(SOCKET_URL || '/', {
    path: '/socket.io',
    withCredentials: true,
    auth: { token: tokenStore.get() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => notifyStatus('connected'));
  socket.on('disconnect', () => notifyStatus('disconnected'));
  socket.on('connect_error', () => notifyStatus('error'));

  return socket;
};

export const disconnectSocket = () => {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  notifyStatus('offline');
};

const notifyStatus = (status) => {
  currentStatus = status;
  statusListeners.forEach((fn) => fn(status));
};

/** Subscribe to a server event. Returns an unsubscribe function. */
export const onSocketEvent = (event, handler) => {
  const s = connectSocket();
  s.on(event, handler);

  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);

  return () => {
    s.off(event, handler);
    listeners.get(event)?.delete(handler);
  };
};

export const onSocketStatus = (handler) => {
  statusListeners.add(handler);
  if (socket) handler(socket.connected ? 'connected' : 'disconnected');
  return () => statusListeners.delete(handler);
};

/**
 * React hook: run `handler` whenever `event` arrives.
 */
export function useSocketEvent(event, handler, deps = []) {
  const saved = useRef(handler);
  saved.current = handler;

  useEffect(() => {
    const wrapped = (...args) => saved.current(...args);
    return onSocketEvent(event, wrapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
}

/** React hook: live connection state for the UI indicator. */
export function useSocketStatus() {
  // Seed from the module value, then stay subscribed. Registering the
  // listener only when `socket` already exists leaves a fresh page load
  // stuck showing "offline" forever.
  const [status, setStatus] = useState(currentStatus);

  useEffect(() => onSocketStatus(setStatus), []);

  return status;
}