const request = require('supertest');
const app = require('../src/app');
const Monitor = require('../src/models/Monitor');
const CheckResult = require('../src/models/CheckResult');
const { registerUser, startFixtureServer } = require('./helpers');
const { executeCheck } = require('../src/services/monitorService');

/**
 * Analytics endpoints.
 *
 * These verify two things:
 *  1. the numbers come from real CheckResult rows
 *  2. missing data is reported as null / "unknown", never as success
 */

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** Insert a synthetic check row directly (faster than running real checks). */
const seedCheck = (monitor, { status, msAgo, responseTimeMs = 120, statusCode = 200 }) =>
  CheckResult.create({
    monitor: monitor._id,
    team: monitor.team,
    status,
    outcome: status === 'down' ? 'failed' : 'ok',
    statusCode: status === 'down' ? statusCode : statusCode,
    responseTimeMs,
    method: 'GET',
    finalUrl: monitor.url,
    source: 'scheduled',
    checkedAt: new Date(Date.now() - msAgo),
  });

describe('GET /api/analytics/dashboard/summary', () => {
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

  it('counts monitors by status', async () => {
    const up = await Monitor.create({
      name: 'Healthy one',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      status: 'up',
    });
    await Monitor.create({
      name: 'Broken one',
      url: fixture.url('/error'),
      team: user.teamId,
      createdBy: user.id,
      status: 'down',
    });
    await Monitor.create({
      name: 'Paused one',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      status: 'paused',
      isPaused: true,
    });

    const res = await request(app).get('/api/analytics/dashboard/summary').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.monitors).toMatchObject({ total: 3, up: 1, down: 1, paused: 1 });
    expect(up).toBeTruthy();
  });

  it('computes uptime from the real check rows', async () => {
    const monitor = await Monitor.create({
      name: 'Uptime subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      intervalSeconds: 3600,
    });

    for (let i = 0; i < 8; i += 1) await seedCheck(monitor, { status: 'up', msAgo: i * 60000 });
    for (let i = 8; i < 10; i += 1)
      await seedCheck(monitor, { status: 'down', msAgo: i * 60000, statusCode: 500 });

    const res = await request(app).get('/api/analytics/dashboard/summary?range=24h').set(user.headers);

    expect(res.body.data.checks.total).toBe(10);
    expect(res.body.data.uptime.percentage).toBe(80); // 8 up / 10
  });

  it('counts a degraded check as half a success', async () => {
    const monitor = await Monitor.create({
      name: 'Degraded subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      intervalSeconds: 3600,
    });

    await seedCheck(monitor, { status: 'up', msAgo: 1000 });
    await seedCheck(monitor, { status: 'degraded', msAgo: 2000 });

    const res = await request(app).get('/api/analytics/dashboard/summary?range=24h').set(user.headers);
    expect(res.body.data.uptime.percentage).toBe(75);
  });

  it('returns null uptime when nothing has been checked yet', async () => {
    const res = await request(app).get('/api/analytics/dashboard/summary').set(user.headers);
    expect(res.body.data.uptime.percentage).toBeNull();
    expect(res.body.data.responseTime.averageMs).toBeNull();
  });

  it('fills empty buckets with nulls instead of a fake uptime', async () => {
    const monitor = await Monitor.create({
      name: 'Sparse subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      intervalSeconds: 3600,
    });
    // one check only
    await seedCheck(monitor, { status: 'up', msAgo: 60_000 });

    const res = await request(app).get('/api/analytics/dashboard/summary?range=24h').set(user.headers);

    const empty = res.body.data.series.filter((b) => b.count === 0);
    expect(empty.length).toBeGreaterThan(10);
    for (const bucket of empty) {
      expect(bucket.uptimePercentage).toBeNull();
      expect(bucket.avgResponseTime).toBeNull();
    }
  });

  it('reports missing checks as unknown, not as success', async () => {
    const monitor = await Monitor.create({
      name: 'Coverage subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      intervalSeconds: 30,
      createdAt: new Date(Date.now() - 3600_000),
    });
    await seedCheck(monitor, { status: 'up', msAgo: 30_000 });

    const res = await request(app).get('/api/analytics/dashboard/summary?range=24h').set(user.headers);

    expect(res.body.data.uptime.unknownChecks).toBeGreaterThan(0);
    expect(res.body.data.uptime.coveragePercentage).toBeLessThan(100);
  });

  it('rejects an unsupported range with 400', async () => {
    const res = await request(app).get('/api/analytics/dashboard/summary?range=99y').set(user.headers);
    expect(res.statusCode).toBe(400);
    expect(res.body.errors.some((e) => e.field === 'range')).toBe(true);
  });

  it('refuses a team the caller does not belong to', async () => {
    const stranger = await registerUser(app);
    const res = await request(app)
      .get(`/api/analytics/dashboard/summary?teamId=${user.teamId}`)
      .set(stranger.headers);

    expect(res.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/dashboard/summary');
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/analytics/monitors', () => {
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

  it('returns one row per monitor with per-monitor uptime', async () => {
    const monitor = await Monitor.create({
      name: 'Table subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      status: 'up',
      intervalSeconds: 3600,
    });

    await seedCheck(monitor, { status: 'up', msAgo: 1000, responseTimeMs: 100 });
    await seedCheck(monitor, { status: 'up', msAgo: 2000, responseTimeMs: 200 });
    await seedCheck(monitor, { status: 'down', msAgo: 3000, responseTimeMs: 300, statusCode: 500 });

    const res = await request(app).get('/api/analytics/monitors?range=24h').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.monitors).toHaveLength(1);
    const row = res.body.data.monitors[0];
    expect(row).toMatchObject({
      name: 'Table subject',
      uptimePercentage: 66.67,
      avgResponseTimeMs: 200,
      checksInRange: 3,
      downInRange: 1,
    });
  });

  it('does not include monitors from other workspaces', async () => {
    await Monitor.create({
      name: 'Private monitor',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
    });
    const stranger = await registerUser(app);

    const res = await request(app).get('/api/analytics/monitors').set(stranger.headers);
    expect(res.body.data.monitors).toHaveLength(0);
  });
});

describe('GET /api/analytics/monitors/:monitorId', () => {
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

  it('calculates latency percentiles from real response times', async () => {
    const monitor = await Monitor.create({
      name: 'Percentile subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      status: 'up',
      intervalSeconds: 3600,
    });

    // 1..100 ms
    for (let i = 1; i <= 100; i += 1) {
      await seedCheck(monitor, { status: 'up', msAgo: i * 1000, responseTimeMs: i * 10 });
    }

    const res = await request(app)
      .get(`/api/analytics/monitors/${monitor._id}?range=24h`)
      .set(user.headers);

    expect(res.statusCode).toBe(200);
    const rt = res.body.data.responseTime;
    expect(rt.averageMs).toBe(505);
    expect(rt.minMs).toBe(10);
    expect(rt.maxMs).toBe(1000);
    expect(rt.p50Ms).toBeGreaterThanOrEqual(500);
    expect(rt.p95Ms).toBeGreaterThanOrEqual(950);
    expect(rt.p99Ms).toBeGreaterThanOrEqual(990);
  });

  it('counts separate outage episodes, not individual failed checks', async () => {
    const monitor = await Monitor.create({
      name: 'Episode subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      status: 'up',
      intervalSeconds: 3600,
    });

    // up, down, down, up, down, up  ->  2 outage episodes
    const sequence = ['up', 'down', 'down', 'up', 'down', 'up'];
    for (let i = 0; i < sequence.length; i += 1) {
      await seedCheck(monitor, {
        status: sequence[i],
        msAgo: (sequence.length - i) * 60_000,
        statusCode: sequence[i] === 'down' ? 500 : 200,
      });
    }

    const res = await request(app)
      .get(`/api/analytics/monitors/${monitor._id}?range=24h`)
      .set(user.headers);

    expect(res.body.data.reliability.failureRuns).toBe(2);
    expect(res.body.data.reliability.failedChecks).toBe(3);
  });

  it('builds a daily summary', async () => {
    const monitor = await Monitor.create({
      name: 'Daily subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      status: 'up',
      intervalSeconds: 3600,
    });

    await seedCheck(monitor, { status: 'up', msAgo: 3_600_000 });
    await seedCheck(monitor, { status: 'up', msAgo: 7_200_000 });

    const res = await request(app)
      .get(`/api/analytics/monitors/${monitor._id}?range=7d`)
      .set(user.headers);

    expect(res.body.data.daily.length).toBeGreaterThan(0);
    for (const day of res.body.data.daily) {
      expect(day).toHaveProperty('date');
      expect(day.uptimePercentage).toBeGreaterThanOrEqual(0);
      expect(day.uptimePercentage).toBeLessThanOrEqual(100);
    }
  });

  it('returns 404 for an unknown monitor', async () => {
    const res = await request(app)
      .get('/api/analytics/monitors/64b7f1c2a1b2c3d4e5f60718')
      .set(user.headers);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a malformed id instead of crashing', async () => {
    const res = await request(app).get('/api/analytics/monitors/not-an-id').set(user.headers);
    expect(res.statusCode).toBe(404);
  });

  it('reports live data produced by a real check', async () => {
    const monitor = await Monitor.create({
      name: 'Live subject',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
    });

    await executeCheck(monitor, { source: 'scheduled' });

    const res = await request(app)
      .get(`/api/analytics/monitors/${monitor._id}?range=24h`)
      .set(user.headers);

    expect(res.body.data.uptime.percentage).toBe(100);
    expect(res.body.data.uptime.totalRecordedChecks).toBe(1);
    expect(res.body.data.responseTime.averageMs).toBeGreaterThanOrEqual(0);
    expect(res.body.data.responseTime.averageMs).toBeLessThan(5000);
  });
});

void iso;