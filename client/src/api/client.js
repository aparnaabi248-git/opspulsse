import axios from 'axios';

/**
 * One shared Axios instance for the whole app.
 *
 * The API returns:
 *   { success: true,  data: ... }
 *   { success: false, message: '...', errors: [{field,message}] }
 *
 * `api` unwraps `data` on success and throws a normalised ApiError on failure,
 * so every page can simply do:
 *
 *   const monitors = await api.get('/monitors')   // -> data.monitors
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  withCredentials: true, // the API also sets an httpOnly cookie
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

export class ApiError extends Error {
  constructor(message, { status, errors = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }

  /** Field name -> message, for inline form validation. */
  get fieldErrors() {
    return this.errors.reduce((acc, e) => ({ ...acc, [e.field]: e.message }), {});
  }
}

const TOKEN_KEY = 'opspulse.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private browsing — the httpOnly cookie still works */
    }
  },
};

api.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Listeners notified when the server rejects our token. */
const unauthorizedHandlers = new Set();
export const onUnauthorized = (fn) => {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
};

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;

    if (status === 401) {
      tokenStore.set(null);
      unauthorizedHandlers.forEach((fn) => fn());
    }

    const raw = error.response?.data;
    const payload = raw && typeof raw === 'object' ? raw : {};

    // When the SPA catch-all rewrite swallows /api, Vercel answers with
    // index.html instead of JSON. Detect that explicitly — otherwise the
    // failure surfaces as a meaningless "Something went wrong".
    const returnedHtml = typeof raw === 'string' && raw.trimStart().startsWith('<');

    const message =
      payload.message ||
      (returnedHtml
        ? 'The API returned a web page instead of JSON. The frontend rewrite for /api is missing or points at the wrong backend.'
        : error.code === 'ECONNABORTED'
          ? 'The server took too long to respond.'
          : error.request && !error.response
            ? 'Cannot reach the OpsPulse API. Is the backend running?'
            : 'Something went wrong. Please try again.');

    return Promise.reject(
      new ApiError(message, { status, errors: payload.errors || [] })
    );
  }
);

// ── Verb helpers ─────────────────────────────────────────────────────
export const get = (url, params) => api.get(url, { params }).then((r) => r.data.data);
export const post = (url, body) => api.post(url, body).then((r) => r.data.data);
export const put = (url, body) => api.put(url, body).then((r) => r.data.data);
export const patch = (url, body) => api.patch(url, body).then((r) => r.data.data);
export const del = (url) => api.delete(url).then((r) => r.data.data);

export default api;