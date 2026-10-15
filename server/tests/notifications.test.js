const request = require('supertest');
const app = require('../src/app');
const Monitor = require('../src/models/Monitor');
const Notification = require('../src/models/Notification');
const { registerUser, registerUserInTeam, startFixtureServer } = require('./helpers');
const { notifyTeam, getUnreadCount } = require('../src/services/alertService');
const { executeCheck } = require('../src/services/monitorService');

/**
 * Notifications: persistence, unread counts, mark-as-read and de-duplication.
 */

describe('Alert dispatch', () => {
  let owner;
  let monitor;

  beforeEach(async () => {
    owner = await registerUser(app);
    monitor = await Monitor.create({
      name: 'Notify Monitor',
      url: 'https://example.com',
      team: owner.teamId,
      createdBy: owner.id,
    });
  });

  it('creates one notification per team member', async () => {
    const colleague = await registerUserInTeam(app, owner.teamId, 'admin');

    const result = await notifyTeam({
      type: 'info',
      dedupeKey: 'test:basic',
      title: 'Test',
      message: 'Something happened',
      team: owner.teamId,
      monitor: monitor._id,
    });

    expect(result.created).toBe(2);
    expect(result.suppressed).toBe(0);
    expect(await Notification.countDocuments({ dedupeKey: 'test:basic' })).toBe(2);

    const notifications = await Notification.find({ dedupeKey: 'test:basic' });
    const userIds = notifications.map((n) => String(n.user)).sort();
    expect(userIds).toEqual([owner.id, colleague.id].sort());
  });

  it('suppresses a duplicate inside the cooldown window', async () => {
    await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'monitor_down:abc',
      title: 'Down',
      message: 'first',
      team: owner.teamId,
      monitor: monitor._id,
    });

    const second = await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'monitor_down:abc',
      title: 'Down',
      message: 'second',
      team: owner.teamId,
      monitor: monitor._id,
    });

    expect(second.created).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(await Notification.countDocuments({ dedupeKey: 'monitor_down:abc' })).toBe(1);
  });

  it('allows a repeat once the cooldown has passed', async () => {
    const cooldown = 120;

    await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'monitor_down:xyz',
      title: 'Down',
      message: 'first',
      team: owner.teamId,
      monitor: monitor._id,
      cooldownMs: cooldown,
    });

    await new Promise((r) => setTimeout(r, cooldown + 40));

    const second = await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'monitor_down:xyz',
      title: 'Down',
      message: 'second',
      team: owner.teamId,
      monitor: monitor._id,
      cooldownMs: cooldown,
    });

    expect(second.created).toBe(1);
    expect(await Notification.countDocuments({ dedupeKey: 'monitor_down:xyz' })).toBe(2);
  });

  it('does not suppress events with a zero cooldown', async () => {
    for (let i = 0; i < 3; i += 1) {
      await notifyTeam({
        type: 'incident_resolved',
        dedupeKey: 'incident_resolved:1',
        title: 'Resolved',
        message: `run ${i}`,
        team: owner.teamId,
        monitor: monitor._id,
      });
    }
    expect(await Notification.countDocuments({ dedupeKey: 'incident_resolved:1' })).toBe(3);
  });

  it('records the honest email status when SMTP is not configured', async () => {
    await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'email:status',
      title: 'Down',
      message: 'test',
      team: owner.teamId,
      monitor: monitor._id,
    });

    const notification = await Notification.findOne({ dedupeKey: 'email:status' });
    // Tests run without SMTP, so it must say "skipped", never "sent"
    expect(notification.email.status).toBe('skipped_not_configured');
    expect(notification.email.sentAt).toBeNull();
    expect(notification.email.error).toMatch(/not configured/i);
  });

  it('never sends notifications to a non-member', async () => {
    const stranger = await registerUser(app);
    await notifyTeam({
      type: 'info',
      dedupeKey: 'scope:test',
      title: 'Scoped',
      message: 'test',
      team: owner.teamId,
      monitor: monitor._id,
    });

    expect(await Notification.countDocuments({ user: stranger.id })).toBe(0);
  });

  it('counts unread notifications per user', async () => {
    await notifyTeam({
      type: 'info',
      dedupeKey: 'unread:1',
      title: 'A',
      message: 'A',
      team: owner.teamId,
      monitor: monitor._id,
    });
    await notifyTeam({
      type: 'info',
      dedupeKey: 'unread:2',
      title: 'B',
      message: 'B',
      team: owner.teamId,
      monitor: monitor._id,
    });

    expect(await getUnreadCount(owner.id)).toBe(2);
  });
});

describe('Alerts triggered by real checks', () => {
  let user;
  let fixture;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    user = await registerUser(app);
  });

  it('notifies when a monitor goes down and again when it recovers', async () => {
    const monitor = await Monitor.create({
      name: 'Alerts Monitor',
      url: fixture.url('/error'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
      recoveryThreshold: 1,
    });

    await executeCheck(monitor, { source: 'scheduled' });

    let notifications = await Notification.find({ user: user.id });
    expect(notifications.some((n) => n.type === 'incident_created')).toBe(true);
    const downNotification = notifications.find((n) => n.type === 'incident_created');
    expect(downNotification.severity).toMatch(/info|warning|critical/);
    expect(downNotification.title).toContain('Alerts Monitor');
    expect(downNotification.read).toBe(false);

    const fresh = await Monitor.findById(monitor._id);
    fresh.url = fixture.url('/health');
    await executeCheck(fresh, { source: 'scheduled' });

    notifications = await Notification.find({ user: user.id });
    expect(notifications.some((n) => n.type === 'incident_resolved')).toBe(true);
  });

  it('notifies about degraded response times', async () => {
    const monitor = await Monitor.create({
      name: 'Degraded Alerts',
      url: fixture.url('/slow?ms=300'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 50,
      failureThreshold: 1,
    });

    await executeCheck(monitor, { source: 'scheduled' });

    const notification = await Notification.findOne({ user: user.id, type: 'monitor_degraded' });
    expect(notification).toBeTruthy();
    expect(notification.severity).toBe('warning');
    expect(notification.message).toMatch(/exceeded the 50 ms threshold/);
  });

  it('does not notify twice while a monitor stays down', async () => {
    const monitor = await Monitor.create({
      name: 'Spam Guard',
      url: fixture.url('/error'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
    });

    for (let i = 0; i < 4; i += 1) {
      const fresh = await Monitor.findById(monitor._id);
      await executeCheck(fresh, { source: 'scheduled' });
    }

    // 4 failures -> one incident, and only ONE "incident opened" notification
    expect(await Notification.countDocuments({ user: user.id, type: 'incident_created' })).toBe(1);
  });
});

describe('Notification API', () => {
  let user;

  beforeEach(async () => {
    user = await registerUser(app);
    const monitor = await Monitor.create({
      name: 'API Notify Monitor',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });

    // Mongoose sets createdAt itself on insert, so create them in order with a
// real gap to guarantee a deterministic newest-first ordering.
const base = {
      user: user.id,
      team: user.teamId,
      monitor: monitor._id,
      message: 'm',
    };

    await Notification.create({ ...base, type: 'monitor_down', severity: 'critical', title: 'Down', dedupeKey: 'a' });
    await new Promise((r) => setTimeout(r, 15));
    await Notification.create({ ...base, type: 'monitor_recovered', severity: 'info', title: 'Back', dedupeKey: 'b' });
    await new Promise((r) => setTimeout(r, 15));
    await Notification.create({ ...base, type: 'info', severity: 'info', title: 'Note', dedupeKey: 'c', read: true, readAt: new Date() });
  });

  it('lists notifications newest first with the unread count', async () => {
    const res = await request(app).get('/api/notifications').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.notifications).toHaveLength(3);
    expect(res.body.data.unreadCount).toBe(2);

    // 'Note' was created last, so it must come first
    expect(res.body.data.notifications.map((n) => n.title)).toEqual(['Note', 'Back', 'Down']);

    const times = res.body.data.notifications.map((n) => new Date(n.createdAt).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    expect(times[1]).toBeGreaterThanOrEqual(times[2]);
  });

  it('filters by unread and type', async () => {
    const unread = await request(app).get('/api/notifications?unread=true').set(user.headers);
    expect(unread.body.data.notifications).toHaveLength(2);

    const typed = await request(app).get('/api/notifications?type=monitor_down').set(user.headers);
    expect(typed.body.data.notifications).toHaveLength(1);
    expect(typed.body.data.notifications[0].title).toBe('Down');
  });

  it('paginates', async () => {
    const res = await request(app).get('/api/notifications?page=1&limit=2').set(user.headers);
    expect(res.body.data.notifications).toHaveLength(2);
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('returns the unread count on its own', async () => {
    const res = await request(app).get('/api/notifications/unread-count').set(user.headers);
    expect(res.body.data.unreadCount).toBe(2);
  });

  it('marks one notification as read', async () => {
    const list = await request(app).get('/api/notifications?unread=true').set(user.headers);
    const target = list.body.data.notifications[0];

    const res = await request(app).post(`/api/notifications/${target._id}/read`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.notification.read).toBe(true);
    expect(res.body.data.notification.readAt).toBeTruthy();
    expect(res.body.data.unreadCount).toBe(1);
  });

  it('marks everything as read', async () => {
    const res = await request(app).post('/api/notifications/read-all').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.unreadCount).toBe(0);
    expect(await Notification.countDocuments({ user: user.id, read: false })).toBe(0);
  });

  it('deletes one notification', async () => {
    const list = await request(app).get('/api/notifications').set(user.headers);
    const target = list.body.data.notifications.find((n) => !n.read);

    const res = await request(app).delete(`/api/notifications/${target._id}`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.unreadCount).toBe(1);
    expect(await Notification.countDocuments({ _id: target._id })).toBe(0);
  });

  it('returns 404 for an unknown notification id', async () => {
    const res = await request(app)
      .post('/api/notifications/64b7f1c2a1b2c3d4e5f60718/read')
      .set(user.headers);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a malformed notification id', async () => {
    const res = await request(app).post('/api/notifications/nope/read').set(user.headers);
    expect(res.statusCode).toBe(404);
  });

  it('cannot touch another user notification', async () => {
    const stranger = await registerUser(app);
    const list = await request(app).get('/api/notifications').set(user.headers);
    const target = list.body.data.notifications.find((n) => !n.read);

    const res = await request(app).post(`/api/notifications/${target._id}/read`).set(stranger.headers);
    expect(res.statusCode).toBe(404);

    const untouched = await Notification.findById(target._id);
    expect(untouched.read).toBe(false);
  });

  it('reports that email is not configured rather than pretending', async () => {
    const res = await request(app).get('/api/notifications/email-status').set(user.headers);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.emailConfigured).toBe(false);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/notifications')).statusCode).toBe(401);
  });
});