import { get, post, put, patch, del } from './client';

/** Auth + profile */
export const authApi = {
  register: (payload) => post('/auth/register', payload),
  login: (payload) => post('/auth/login', payload),
  logout: () => post('/auth/logout'),
  me: () => get('/auth/me'),
  updateProfile: (payload) => put('/auth/profile', payload),
  changePassword: (payload) => put('/auth/change-password', payload),
};

/** Monitors */
export const monitorsApi = {
  list: (params) => get('/monitors', params),
  get: (id) => get(`/monitors/${id}`),
  create: (payload) => post('/monitors', payload),
  update: (id, payload) => put(`/monitors/${id}`, payload),
  pause: (id) => patch(`/monitors/${id}/pause`),
  resume: (id) => patch(`/monitors/${id}/resume`),
  runCheck: (id) => post(`/monitors/${id}/check`),
  history: (id, params) => get(`/monitors/${id}/checks`, params),
  remove: (id) => del(`/monitors/${id}`),
};

/** Activity feed */
export const checksApi = {
  recent: (params) => get('/checks/recent', params),
};

/** Analytics / dashboard */
export const analyticsApi = {
  summary: (params) => get('/analytics/dashboard/summary', params),
  monitorTable: (params) => get('/analytics/monitors', params),
  monitor: (id, params) => get(`/analytics/monitors/${id}`, params),
};

/** Incidents */
export const incidentsApi = {
  list: (params) => get('/incidents', params),
  summary: () => get('/incidents/summary'),
  get: (id) => get(`/incidents/${id}`),
  acknowledge: (id) => post(`/incidents/${id}/acknowledge`),
  resolve: (id, notes) => post(`/incidents/${id}/resolve`, { notes }),
  addNote: (id, note) => post(`/incidents/${id}/note`, { note }),
};

/** Reports: daily / weekly summaries */
export const reportsApi = {
  daily: (params) => get('/analytics/reports/daily', params),
  weekly: (params) => get('/analytics/reports/weekly', params),
  lifetime: (monitorId) => get(`/analytics/reports/lifetime/${monitorId}`),
};

/** Notification centre */
export const notificationsApi = {
  list: (params) => get('/notifications', params),
  unreadCount: () => get('/notifications/unread-count'),
  emailStatus: () => get('/notifications/email-status'),
  markAsRead: (id) => post(`/notifications/${id}/read`),
  markAllAsRead: () => post('/notifications/read-all'),
  remove: (id) => del(`/notifications/${id}`),
};

/** Teams */
export const teamsApi = {
  list: () => get('/teams'),
  get: (id) => get(`/teams/${id}`),
  stats: (id) => get(`/teams/${id}/stats`),
  create: (payload) => post('/teams', payload),
  update: (id, payload) => put(`/teams/${id}`, payload),
  remove: (id) => del(`/teams/${id}`),
  addMember: (id, payload) => post(`/teams/${id}/members`, payload),
  updateMember: (id, userId, role) => put(`/teams/${id}/members/${userId}`, { role }),
  removeMember: (id, userId) => del(`/teams/${id}/members/${userId}`),
  transferOwnership: (id, newOwnerId) => post(`/teams/${id}/transfer-ownership`, { teamId: id, newOwnerId }),
  leave: (id) => post(`/teams/${id}/leave`),
};

/** Personal settings and notification preferences */
export const settingsApi = {
  get: () => get('/settings'),
  updatePreferences: (payload) => put('/settings/preferences', payload),
  testEmail: (to) => post('/settings/test-email', { to }),
  clearNotifications: () => del('/settings/notifications'),
};