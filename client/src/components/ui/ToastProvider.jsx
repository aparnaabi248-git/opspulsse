import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Toast notifications.
 * Every real API action in the app reports its result here, so the user
 * always knows whether something actually worked.
 *
 * The provider both publishes the toast API through context AND renders the
 * live toast region — the two must live together or toasts would be created
 * but never shown.
 */

const ToastContext = createContext(null);

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, { type = 'info', duration = 4500 } = {}) => {
      const id = nextId;
      nextId += 1;
      setToasts((current) => [...current, { id, message, type }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss]
  );

  const value = useMemo(
    () => ({
      toasts,
      dismiss,
      success: (message, options) => push(message, { ...options, type: 'success' }),
      error: (message, options) => push(message, { ...options, type: 'error', duration: 7000 }),
      info: (message, options) => push(message, { ...options, type: 'info' }),
    }),
    [toasts, push, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Live region so screen readers announce the result too */}
      <div className="toast-region" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast ${toast.type}`}
            role={toast.type === 'error' ? 'alert' : 'status'}
          >
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}