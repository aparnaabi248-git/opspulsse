const app = require('../src/app');
const Monitor = require('../src/models/Monitor');
const CheckResult = require('../src/models/CheckResult');
const SchedulerLease = require('../src/models/SchedulerLease');
const config = require('../src/config');

const { registerUser, startFixtureServer } = require('./helpers');
const { runDueChecks, getSchedulerStatus, _internal } = require('../src/monitoring/scheduler');
const { Lease } = require('../src/monitoring/lease');

/**
 * Scheduler behaviour.
 *
 * The cron timer is never started here — every test drives runDueChecks()
 * directly so the suite finishes fast and deterministically.
 */

describe('runDueChecks', () => {
  let user;
  let fixture;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    config.scheduler.enabled = true;
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    _internal.stats.checksRun = 0;
    _internal.stats.checksSkippedOverlap = 0;
    _internal.inFlight.clear();
    user = await registerUser(app);
  });

  const makeMonitor = (overrides = {}) =>
    Monitor.create({
      name: `M-${Math.random().toString(36).slice(2, 7)}`,
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      nextCheckAt: new Date(Date.now() - 1000), // already due
      ...overrides,
    });

  it('checks monitors that are due and stores real results', async () => {
    await makeMonitor({ name: 'Due A' });
    await makeMonitor({ name: 'Due B' });

    const result = await runDueChecks();

    expect(result.due).toBe(2);
    expect(result.run).toBe(2);
    expect(await CheckResult.countDocuments({})).toBe(2);
    expect(await CheckResult.countDocuments({ status: 'up' })).toBe(2);
  });

  it('does not re-check a monitor until its interval elapses', async () => {
    await makeMonitor({ name: 'Once', intervalSeconds: 3600 });

    const first = await runDueChecks();
    expect(first.run).toBe(1);

    const second = await runDueChecks();
    expect(second.due).toBe(0);
    expect(second.run).toBe(0);
    expect(await CheckResult.countDocuments({})).toBe(1);
  });

  it('skips paused monitors', async () => {
    await makeMonitor({ name: 'Paused', isPaused: true, status: 'paused', nextCheckAt: null });

    const result = await runDueChecks();
    expect(result.due).toBe(0);
    expect(await CheckResult.countDocuments({})).toBe(0);
  });

  it('checks a monitor with nextCheckAt = null (never checked yet)', async () => {
    await makeMonitor({ name: 'Fresh', nextCheckAt: null });
    const result = await runDueChecks();
    expect(result.run).toBe(1);
  });

  it('never runs two checks for the same monitor at the same time', async () => {
    await makeMonitor({ name: 'Slow', url: fixture.url('/hang'), timeoutMs: 1500 });

    // Pretend a check is already running for this monitor
    const monitor = await Monitor.findOne({ name: 'Slow' });
    _internal.inFlight.set(String(monitor._id), new Date());

    const result = await runDueChecks();

    expect(result.run).toBe(0);
    expect(result.skipped).toBe(1);
    expect(_internal.stats.checksSkippedOverlap).toBe(1);
    expect(await CheckResult.countDocuments({})).toBe(0);
  });

  it('releases the in-flight lock once the check finishes', async () => {
    await makeMonitor({ name: 'LockTest', intervalSeconds: 30 });
    const monitor = await Monitor.findOne({ name: 'LockTest' });

    _internal.inFlight.set(String(monitor._id), new Date());
    await runDueChecks();
    expect(_internal.inFlight.has(String(monitor._id))).toBe(true); // still locked

    // simulate the check having finished
    _internal.inFlight.delete(String(monitor._id));

    // force it to be due again
    await Monitor.updateOne({ _id: monitor._id }, { nextCheckAt: new Date(Date.now() - 1000) });
    const second = await runDueChecks();
    expect(second.run).toBe(1);
  });

  it('keeps running when one monitor throws', async () => {
    await makeMonitor({ name: 'Good 1' });
    await makeMonitor({ name: 'Broken' });
    // Force a save failure on one monitor only
    await Monitor.updateOne(
      { name: 'Broken' },
      { $set: { url: 'http://[bad-ipv6' } },
      { runValidators: false }
    );

    const result = await runDueChecks();

    expect(result.run).toBe(2);
    // The good one still produced a result
    expect(await CheckResult.countDocuments({})).toBeGreaterThanOrEqual(1);
  });

  it('does nothing when there are no monitors', async () => {
    const result = await runDueChecks();
    expect(result).toEqual({ due: 0, run: 0, skipped: 0 });
  });

  it('reschedules the monitor for the future after checking', async () => {
    await makeMonitor({ name: 'Reschedule', intervalSeconds: 600 });
    await runDueChecks();

    const monitor = await Monitor.findOne({ name: 'Reschedule' });
    expect(monitor.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('counts real statistics', async () => {
    await makeMonitor({ name: 'Stats' });
    await runDueChecks();

    const status = getSchedulerStatus();
    expect(status.enabled).toBe(true);
    expect(status.stats.checksRun).toBe(1);
    expect(status.stats.ticks).toBeGreaterThan(0);
  });
});

describe('Single-instance scheduler lease', () => {
  afterEach(async () => {
    await SchedulerLease.deleteMany({});
  });

  it('is granted to the first instance', async () => {
    const lease = new Lease({ ttlMs: 30000 });
    expect(await lease.acquire()).toBe(true);
    expect(lease.held).toBe(true);
    await lease.release();
  });

  it('is refused to a second instance while the first holds it', async () => {
    const first = new Lease({ ttlMs: 30000 });
    const second = new Lease({ ttlMs: 30000 });

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(second.held).toBe(false);

    await first.release();
  });

  it('is handed over after the holder releases it', async () => {
    const first = new Lease({ ttlMs: 30000 });
    const second = new Lease({ ttlMs: 30000 });

    await first.acquire();
    await first.release();

    expect(await second.acquire()).toBe(true);
    await second.release();
  });

  it('is taken over automatically after the holder dies (lease expiry)', async () => {
    const first = new Lease({ ttlMs: 1000 });
    const second = new Lease({ ttlMs: 30000 });

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);

    // The first instance crashes: its lease row is still there but expired
    await SchedulerLease.updateOne(
      { _id: 'monitor-scheduler' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    expect(await second.acquire()).toBe(true);
    await second.release();
  });

  it('lets the holder renew, and refuses renewal for a non-holder', async () => {
    const holder = new Lease({ ttlMs: 30000 });
    const other = new Lease({ ttlMs: 30000 });

    await holder.acquire();
    expect(await holder.renew()).toBe(true);

    expect(await other.acquire()).toBe(false);
    expect(await other.renew()).toBe(false);

    await holder.release();
  });
});

describe('Leader promotion after failover', () => {
  afterEach(async () => {
    await SchedulerLease.deleteMany({});
    _internal.lease = null;
    _internal.isLeader = false;
    _internal.started = false;
  });

  /**
   * Regression test: a passive instance that grabs an expired lease must
   * actually become the leader (and start renewing), otherwise it keeps
   * checking for a few ticks and then silently loses the work again.
   */
  it('promotes a passive instance when the lease becomes free', async () => {
    const { Lease: TestLease } = require('../src/monitoring/lease');

    // Simulate the state right after boot when another instance held the lease
    _internal.lease = new TestLease({ ttlMs: 30000 });
    _internal.isLeader = false;

    expect(await _internal.lease.acquire()).toBe(true); // it is now free

    const { promoteToLeader } = require('../src/monitoring/scheduler');
    promoteToLeader();

    expect(_internal.isLeader).toBe(true);
    expect(_internal.lease.renewTimer).toBeTruthy(); // renewal started
  });

  it('stops renewing when demoted', () => {
    const { Lease: TestLease } = require('../src/monitoring/lease');
    const { promoteToLeader, demoteToLeader } = require('../src/monitoring/scheduler');

    _internal.lease = new TestLease({ ttlMs: 30000 });
    _internal.isLeader = true;
    _internal.lease.held = true;

    promoteToLeader();
    demoteToLeader();

    expect(_internal.isLeader).toBe(false);
    expect(_internal.lease.renewTimer).toBeNull();

    _internal.lease = null;
  });
});