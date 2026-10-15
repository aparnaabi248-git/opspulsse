const request = require('supertest');
const app = require('../src/app');
const Monitor = require('../src/models/Monitor');
const CheckResult = require('../src/models/CheckResult');
const { registerUser, startFixtureServer } = require('./helpers');
const { executeCheck, applyStatusTransition } = require('../src/services/monitorService');

/**
 * Status transitions + persistence of real check results.
 */

describe('Status transition engine (pure)', () => {
  const makeMonitor = (overrides = {}) =>
    new Monitor({
      name: 'Transition Monitor',
      url: 'https://example.com',
      team: new Monitor().team,
      createdBy: new Monitor().createdBy,
      status: 'pending',
      recoveryThreshold: 1,
      ...overrides,
    });

  it('moves pending -> up on the first successful check', () => {
    const m = makeMonitor({ status: 'pending' });
    const t = applyStatusTransition(m, 'up');
    expect(t).toMatchObject({ previousStatus: 'pending', newStatus: 'up', changed: true });
  });

  it('moves up -> down and counts the failure', () => {
    const m = makeMonitor({ status: 'up', consecutiveSuccesses: 3 });
    const t = applyStatusTransition(m, 'down');
    expect(t.newStatus).toBe('down');
    expect(t.changed).toBe(true);
    expect(t.isFlapping).toBe(true);
    expect(m.consecutiveFailures).toBe(1);
    expect(m.consecutiveSuccesses).toBe(0);
  });

  it('moves up -> degraded without counting a failure', () => {
    const m = makeMonitor({ status: 'up' });
    const t = applyStatusTransition(m, 'degraded');
    expect(t.newStatus).toBe('degraded');
    expect(m.consecutiveFailures).toBe(0);
    expect(m.consecutiveSuccesses).toBe(1);
  });

  it('down -> up is a recovery', () => {
    const m = makeMonitor({ status: 'down', consecutiveFailures: 4 });
    const t = applyStatusTransition(m, 'up');
    expect(t.newStatus).toBe('up');
    expect(t.isRecovery).toBe(true);
    expect(m.consecutiveFailures).toBe(0);
  });

  it('reports no change when the status stays the same', () => {
    const m = makeMonitor({ status: 'down' });
    const t = applyStatusTransition(m, 'down');
    expect(t.changed).toBe(false);
    expect(m.consecutiveFailures).toBe(1);
  });

  describe('recoveryThreshold', () => {
    it('keeps the monitor DOWN until enough successes are seen', () => {
      const m = makeMonitor({ status: 'down', recoveryThreshold: 3 });

      applyStatusTransition(m, 'up');
      expect(m.status).toBe('down');
      expect(m.isRecovering).toBe(true);
      expect(m.consecutiveSuccesses).toBe(1);

      applyStatusTransition(m, 'up');
      expect(m.status).toBe('down');
      expect(m.consecutiveSuccesses).toBe(2);

      const third = applyStatusTransition(m, 'up');
      expect(m.status).toBe('up');
      expect(m.isRecovering).toBe(false);
      expect(third.isRecovery).toBe(true);
    });

    it('resets the recovery progress when it fails again', () => {
      const m = makeMonitor({ status: 'down', recoveryThreshold: 3 });
      applyStatusTransition(m, 'up');
      applyStatusTransition(m, 'up');
      expect(m.isRecovering).toBe(true);

      applyStatusTransition(m, 'down');
      expect(m.isRecovering).toBe(false);
      expect(m.consecutiveSuccesses).toBe(0);
      expect(m.consecutiveFailures).toBe(1);
    });
  });
});

describe('Persistence of real checks', () => {
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

  const newMonitor = (overrides = {}) =>
    Monitor.create({
      name: 'Persistence Monitor',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      ...overrides,
    });

  it('stores a CheckResult and updates the monitor', async () => {
    const monitor = await newMonitor();
    const { checkResult, transition } = await executeCheck(monitor, { source: 'scheduled' });

    expect(checkResult.status).toBe('up');
    expect(checkResult.outcome).toBe('ok');
    expect(checkResult.source).toBe('scheduled');
    expect(checkResult.responseTimeMs).toBeGreaterThanOrEqual(0);

    const stored = await Monitor.findById(monitor._id);
    expect(stored.status).toBe('up');
    expect(stored.totalChecks).toBe(1);
    expect(stored.totalUp).toBe(1);
    expect(stored.lastStatusCode).toBe(200);
    expect(stored.lastResolvedIp).toBe('127.0.0.1');
    expect(transition.changed).toBe(true);
  });

  it('records the real failure reason', async () => {
    const monitor = await newMonitor({ url: fixture.url('/error') });
    await executeCheck(monitor, { source: 'scheduled' });

    const stored = await Monitor.findById(monitor._id);
    expect(stored.status).toBe('down');
    expect(stored.totalDown).toBe(1);
    expect(stored.lastError).toMatch(/Unexpected status code 500/);
    expect(stored.downSince).toBeTruthy();
  });

  it('accumulates downtime and clears it on recovery', async () => {
    const monitor = await newMonitor({ url: fixture.url('/error') });
    await executeCheck(monitor, { source: 'scheduled' });

    const down = await Monitor.findById(monitor._id);
    down.downSince = new Date(Date.now() - 60_000); // pretend it went down 1 min ago
    await down.save();

    down.url = fixture.url('/health');
    await executeCheck(down, { source: 'scheduled' });

    const up = await Monitor.findById(monitor._id);
    expect(up.status).toBe('up');
    expect(up.downSince).toBeNull();
    expect(up.lastDowntimeMs).toBeGreaterThanOrEqual(59_000);
    expect(up.totalDowntimeMs).toBeGreaterThanOrEqual(59_000);
  });

  it('advances nextCheckAt using the monitor interval', async () => {
    const monitor = await newMonitor({ intervalSeconds: 60 });
    await executeCheck(monitor, { source: 'scheduled' });

    const stored = await Monitor.findById(monitor._id);
    const delta = stored.nextCheckAt.getTime() - stored.lastCheckAt.getTime();
    expect(Math.round(delta / 1000)).toBe(60);
  });

  it('writes a separate row per check so history is real', async () => {
    const monitor = await newMonitor();
    await executeCheck(monitor, { source: 'scheduled' });
    await executeCheck(monitor, { source: 'scheduled' });
    await executeCheck(monitor, { source: 'manual' });

    const checks = await CheckResult.find({ monitor: monitor._id }).sort({ checkedAt: 1 });
    expect(checks).toHaveLength(3);
    expect(checks.map((c) => c.source).sort()).toEqual(['manual', 'scheduled', 'scheduled']);
    expect(new Set(checks.map((c) => c.checkedAt.getTime())).size).toBe(3);
  });

  it('records a timeout as a real timeout outcome', async () => {
    const monitor = await newMonitor({ url: fixture.url('/hang'), timeoutMs: 1000 });
    await executeCheck(monitor, { source: 'scheduled' });

    const stored = await Monitor.findById(monitor._id);
    expect(stored.status).toBe('down');
    expect(stored.lastError).toMatch(/timed out/i);

    const check = await CheckResult.findOne({ monitor: monitor._id });
    expect(check.outcome).toBe('timeout');
    expect(check.statusCode).toBeNull();
  });
});

describe('Recent activity feed', () => {
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

  it('returns recent checks with the monitor name', async () => {
    const monitor = await Monitor.create({
      name: 'Feed monitor',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
    });
    await executeCheck(monitor, { source: 'scheduled' });

    const res = await request(app).get('/api/checks/recent').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.activity).toHaveLength(1);
    expect(res.body.data.activity[0]).toMatchObject({
      monitorName: 'Feed monitor',
      status: 'up',
      source: 'scheduled',
    });
  });

  it('does not leak another workspace activity', async () => {
    const stranger = await registerUser(app);
    const res = await request(app).get('/api/checks/recent').set(stranger.headers);
    expect(res.body.data.activity).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/checks/recent');
    expect(res.statusCode).toBe(401);
  });
});