const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Monitor = require('../src/models/Monitor');
const Incident = require('../src/models/Incident');
const CheckResult = require('../src/models/CheckResult');
const Notification = require('../src/models/Notification');
const TeamMember = require('../src/models/TeamMember');
const { registerUser, registerUserInTeam, startFixtureServer } = require('./helpers');
const { executeCheck } = require('../src/services/monitorService');
const { notifyTeam } = require('../src/services/alertService');

/**
 * Phase 6: reports, user settings/preferences and team management.
 */

// ── Helpers ──────────────────────────────────────────────────────────

const seedCheck = (monitor, { status, daysAgo, responseTimeMs = 120, statusCode = 200 }) =>
  CheckResult.create({
    monitor: monitor._id,
    team: monitor.team,
    status,
    outcome: status === 'down' ? 'failed' : 'ok',
    statusCode,
    responseTimeMs,
    method: 'GET',
    finalUrl: monitor.url,
    source: 'scheduled',
    checkedAt: new Date(Date.now() - daysAgo * 86_400_000),
  });

describe('Daily report', () => {
  let user;

  beforeEach(async () => {
    user = await registerUser(app);
  });

  it('returns one continuous entry per day', async () => {
    const monitor = await Monitor.create({
      name: 'Daily Monitor',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await seedCheck(monitor, { status: 'up', daysAgo: 1, responseTimeMs: 100 });
    await seedCheck(monitor, { status: 'up', daysAgo: 3, responseTimeMs: 200 });

    const res = await request(app).get('/api/analytics/reports/daily?days=7').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.granularity).toBe('day');
    expect(res.body.data.periods).toHaveLength(7);
  });

  it('leaves days without data as null rather than 100%', async () => {
    const monitor = await Monitor.create({
      name: 'Sparse Monitor',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await seedCheck(monitor, { status: 'up', daysAgo: 2 });

    const res = await request(app).get('/api/analytics/reports/daily?days=5').set(user.headers);

    const emptyDays = res.body.data.periods.filter((p) => p.total === 0);
    expect(emptyDays.length).toBeGreaterThan(2);
    for (const day of emptyDays) {
      expect(day.uptimePercentage).toBeNull();
      expect(day.avgResponseTime).toBeNull();
    }
    expect(res.body.data.totals.daysWithNoData).toBe(emptyDays.length);
  });

  it('computes uptime per day from the real checks', async () => {
    const monitor = await Monitor.create({
      name: 'Uptime By Day',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    // yesterday: 3 up, 1 down -> 75%; the day before: 2 up -> 100%
    await seedCheck(monitor, { status: 'up', daysAgo: 1 });
    await seedCheck(monitor, { status: 'up', daysAgo: 1 });
    await seedCheck(monitor, { status: 'up', daysAgo: 1 });
    await seedCheck(monitor, { status: 'down', daysAgo: 1, statusCode: 500 });
    await seedCheck(monitor, { status: 'up', daysAgo: 2 });
    await seedCheck(monitor, { status: 'up', daysAgo: 2 });

    const res = await request(app).get('/api/analytics/reports/daily?days=3').set(user.headers);

    // periods are oldest first, so the most recent day with data is the last one
    const yesterday = res.body.data.periods.filter((p) => p.total > 0).pop();
    expect(yesterday.total).toBe(4);
    expect(yesterday.uptimePercentage).toBe(75);
    expect(res.body.data.totals.bestUptime).toBe(100);
    expect(res.body.data.totals.worstUptime).toBe(75);
  });

  it('counts incidents that started on each day', async () => {
    const monitor = await Monitor.create({
      name: 'Incident Day Monitor',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await Incident.create({
      title: 'Yesterday outage',
      monitor: monitor._id,
      team: user.teamId,
      startedAt: new Date(Date.now() - 86_400_000),
      active: false,
      status: 'resolved',
      resolvedAt: new Date(),
    });
    await Incident.create({
      title: 'Today outage',
      monitor: monitor._id,
      team: user.teamId,
      startedAt: new Date(),
    });

    const res = await request(app).get('/api/analytics/reports/daily?days=2').set(user.headers);
    expect(res.body.data.totals.incidents).toBe(2);
  });

  it('rejects an out-of-range days parameter', async () => {
    const res = await request(app).get('/api/analytics/reports/daily?days=400').set(user.headers);
    expect(res.statusCode).toBe(400);
  });

  it('refuses a team the caller does not belong to', async () => {
    const stranger = await registerUser(app);
    const res = await request(app)
      .get(`/api/analytics/reports/daily?teamId=${user.teamId}`)
      .set(stranger.headers);
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/analytics/reports/daily')).statusCode).toBe(401);
  });
});

describe('Weekly report', () => {
  let user;

  beforeEach(async () => {
    user = await registerUser(app);
  });

  it('returns one continuous entry per week', async () => {
    const monitor = await Monitor.create({
      name: 'Weekly Monitor',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await seedCheck(monitor, { status: 'up', daysAgo: 2 });
    await seedCheck(monitor, { status: 'down', daysAgo: 2, statusCode: 500 });

    const res = await request(app).get('/api/analytics/reports/weekly?weeks=4').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.granularity).toBe('week');
    expect(res.body.data.periods).toHaveLength(4);
  });

  it('groups checks into the week they happened in', async () => {
    const monitor = await Monitor.create({
      name: 'Weekly Grouping',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await seedCheck(monitor, { status: 'up', daysAgo: 1 });
    await seedCheck(monitor, { status: 'down', daysAgo: 1, statusCode: 500 });

    const res = await request(app).get('/api/analytics/reports/weekly?weeks=2').set(user.headers);

    const withData = res.body.data.periods.filter((p) => p.total > 0);
    expect(withData).toHaveLength(1);
    expect(withData[0].total).toBe(2);
    expect(withData[0].uptimePercentage).toBe(50);
  });

  it('can be scoped to a single monitor', async () => {
    const a = await Monitor.create({
      name: 'Report Monitor A',
      url: 'https://a.example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    const b = await Monitor.create({
      name: 'Report Monitor B',
      url: 'https://b.example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await seedCheck(a, { status: 'up', daysAgo: 1 });
    await seedCheck(b, { status: 'down', daysAgo: 1, statusCode: 500 });

    const res = await request(app)
      .get(`/api/analytics/reports/daily?days=3&monitor=${a._id}`)
      .set(user.headers);

    const total = res.body.data.periods.reduce((sum, p) => sum + p.total, 0);
    expect(total).toBe(1);
  });
});

describe('Lifetime report', () => {
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

  it('summarises everything ever recorded for a monitor', async () => {
    const monitor = await Monitor.create({
      name: 'Lifetime Monitor',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
    });

    await executeCheck(monitor, { source: 'scheduled' });
    const fresh = await Monitor.findById(monitor._id);
    await executeCheck(fresh, { source: 'scheduled' });

    const res = await request(app)
      .get(`/api/analytics/reports/lifetime/${monitor._id}`)
      .set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Lifetime Monitor',
      totalChecks: 2,
      uptimePercentage: 100,
    });
    expect(res.body.data.counts).toMatchObject({ up: 2, down: 0 });
  });

  it('hides a monitor from another workspace', async () => {
    const monitor = await Monitor.create({
      name: 'Private Lifetime',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    const stranger = await registerUser(app);

    const res = await request(app)
      .get(`/api/analytics/reports/lifetime/${monitor._id}`)
      .set(stranger.headers);
    expect(res.statusCode).toBe(404);
  });
});

describe('Settings and preferences', () => {
  let user;

  beforeEach(async () => {
    user = await registerUser(app);
  });

  it('returns the profile and honest capabilities', async () => {
    const res = await request(app).get('/api/settings').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.preferences).toMatchObject({
      inAppEnabled: true,
      emailEnabled: false,
    });
    expect(res.body.data.capabilities.smtpConfigured).toBe(false);
    // Credentials must never leak
    expect(JSON.stringify(res.body)).not.toMatch(/smtp_pass|SMTP_PASS/i);
  });

  it('saves preferences', async () => {
    const res = await request(app)
      .put('/api/settings/preferences')
      .set(user.headers)
      .send({ emailEnabled: true, emailTypes: ['monitor_down', 'incident_created'] });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.preferences).toMatchObject({
      emailEnabled: true,
      emailTypes: ['monitor_down', 'incident_created'],
    });

    const stored = await User.findById(user.id);
    expect(stored.preferences.emailEnabled).toBe(true);
    expect(stored.preferences.emailTypes).toHaveLength(2);
  });

  it('rejects an unknown alert type', async () => {
    const res = await request(app)
      .put('/api/settings/preferences')
      .set(user.headers)
      .send({ emailTypes: ['nuclear_launch'] });

    expect(res.statusCode).toBe(400);
    expect(res.body.errors.some((e) => e.field === 'emailTypes')).toBe(true);
  });

  it('rejects an empty type list', async () => {
    const res = await request(app)
      .put('/api/settings/preferences')
      .set(user.headers)
      .send({ emailTypes: [] });
    expect(res.statusCode).toBe(400);
  });

  it('reports that a test email was NOT sent when SMTP is off', async () => {
    const res = await request(app).post('/api/settings/test-email').set(user.headers);

    expect(res.statusCode).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.data.sent).toBe(false);
    expect(res.body.data.reason).toBe('smtp_not_configured');
    expect(res.body.message).toMatch(/SMTP is not configured/);
  });

  it('validates the test-email address', async () => {
    const res = await request(app)
      .post('/api/settings/test-email')
      .set(user.headers)
      .send({ to: 'not-an-email' });
    expect(res.statusCode).toBe(400);
  });

  it('deletes the caller notifications', async () => {
    const monitor = await Monitor.create({
      name: 'Settings Notify',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await notifyTeam({
      type: 'info',
      dedupeKey: 'settings:1',
      title: 'Hi',
      message: 'Hi',
      team: user.teamId,
      monitor: monitor._id,
    });

    const res = await request(app).delete('/api/settings/notifications').set(user.headers);
    expect(res.statusCode).toBe(200);
    expect(await Notification.countDocuments({ user: user.id })).toBe(0);
  });

  it('cannot read or change another user settings', async () => {
    const stranger = await registerUser(app);
    const res = await request(app)
      .put('/api/settings/preferences')
      .set(stranger.headers)
      .send({ emailEnabled: true });

    // Succeeds, but only for the stranger's own account
    expect(res.statusCode).toBe(200);
    const ownerSettings = await User.findById(user.id);
    expect(ownerSettings.preferences.emailEnabled).toBe(false);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/settings')).statusCode).toBe(401);
  });
});

describe('Preferences change what gets delivered', () => {
  let user;
  let monitor;

  beforeEach(async () => {
    user = await registerUser(app);
    monitor = await Monitor.create({
      name: 'Preference Monitor',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
  });

  it('creates no in-app notification when in-app alerts are off', async () => {
    await User.updateOne(
      { _id: user.id },
      { $set: { 'preferences.inAppEnabled': false } }
    );

    const result = await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'pref:inapp:off',
      title: 'Down',
      message: 'test',
      team: user.teamId,
      monitor: monitor._id,
    });

    expect(result.created).toBe(0);
    expect(result.skippedByPreference).toBe(1);
    expect(await Notification.countDocuments({ user: user.id })).toBe(0);
  });

  it('records an honest reason when email alerts are disabled by the user', async () => {
    await User.updateOne(
      { _id: user.id },
      { $set: { 'preferences.emailEnabled': false } }
    );

    await notifyTeam({
      type: 'monitor_down',
      dedupeKey: 'pref:email:off',
      title: 'Down',
      message: 'test',
      team: user.teamId,
      monitor: monitor._id,
    });

    const notification = await Notification.findOne({ dedupeKey: 'pref:email:off' });
    // The in-app notification still exists…
    expect(notification).toBeTruthy();
    // …and the email status says exactly why nothing was emailed
    expect(notification.email.status).toBe('skipped_not_configured');
  });
});

describe('Team management', () => {
  let owner;

  beforeEach(async () => {
    owner = await registerUser(app);
  });

  it('returns live counts for the team screen', async () => {
    const member = await registerUserInTeam(app, owner.teamId, 'admin');

    await Monitor.create({
      name: 'Stats Up Monitor',
      url: 'https://example.com',
      team: owner.teamId,
      createdBy: owner.id,
      status: 'up',
    });
    await Monitor.create({
      name: 'Stats Down Monitor',
      url: 'https://example.com',
      team: owner.teamId,
      createdBy: owner.id,
      status: 'down',
    });

    const res = await request(app).get(`/api/teams/${owner.teamId}/stats`).set(owner.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      members: 2,
      monitors: 2,
      activeIncidents: 0,
    });
    expect(res.body.data.monitorsByStatus).toMatchObject({ up: 1, down: 1 });
    expect(member.id).toBeTruthy();
  });

  it('transfers ownership and demotes the previous owner to admin', async () => {
    const newOwner = await registerUserInTeam(app, owner.teamId, 'viewer');

    const res = await request(app)
      .post(`/api/teams/${owner.teamId}/transfer-ownership`)
      .set(owner.headers)
      .send({ teamId: owner.teamId, newOwnerId: newOwner.id });

    expect(res.statusCode).toBe(200);

    const memberships = await TeamMember.find({ team: owner.teamId }).sort({ role: 1 });
    expect(memberships.find((m) => String(m.user) === newOwner.id).role).toBe('owner');
    expect(memberships.find((m) => String(m.user) === owner.id).role).toBe('admin');

    const Team = require('../src/models/Team');
    const team = await Team.findById(owner.teamId);
    expect(String(team.owner)).toBe(newOwner.id);
  });

  it('does not let a non-owner transfer ownership', async () => {
    const admin = await registerUserInTeam(app, owner.teamId, 'admin');
    const target = await registerUserInTeam(app, owner.teamId, 'viewer');

    const res = await request(app)
      .post(`/api/teams/${owner.teamId}/transfer-ownership`)
      .set(admin.headers)
      .send({ teamId: owner.teamId, newOwnerId: target.id });

    expect(res.statusCode).toBe(403);
  });

  it('rejects transferring to a non-member', async () => {
    const stranger = await registerUser(app);

    const res = await request(app)
      .post(`/api/teams/${owner.teamId}/transfer-ownership`)
      .set(owner.headers)
      .send({ teamId: owner.teamId, newOwnerId: stranger.id });

    expect(res.statusCode).toBe(404);
  });

  it('lets a non-owner leave the team', async () => {
    const admin = await registerUserInTeam(app, owner.teamId, 'admin');

    const res = await request(app).post(`/api/teams/${owner.teamId}/leave`).set(admin.headers);

    expect(res.statusCode).toBe(200);
    expect(await TeamMember.countDocuments({ team: owner.teamId, user: admin.id })).toBe(0);
  });

  it('refuses to let the owner walk away', async () => {
    const res = await request(app).post(`/api/teams/${owner.teamId}/leave`).set(owner.headers);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Transfer ownership or delete/i);
  });

  it('hides team stats from other workspaces', async () => {
    const stranger = await registerUser(app);
    const res = await request(app).get(`/api/teams/${owner.teamId}/stats`).set(stranger.headers);
    expect(res.statusCode).toBe(403);
  });
});