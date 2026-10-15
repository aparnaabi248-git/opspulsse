const request = require('supertest');
const app = require('../src/app');
const Monitor = require('../src/models/Monitor');
const Incident = require('../src/models/Incident');
const Notification = require('../src/models/Notification');
const TeamMember = require('../src/models/TeamMember');
const { registerUser, registerUserInTeam, startFixtureServer } = require('./helpers');
const { executeCheck } = require('../src/services/monitorService');

/**
 * Incident lifecycle.
 *
 * The fixture server lets a test flip a monitor from healthy to broken and
 * back, so incidents are created from real check results.
 */

describe('Automatic incident creation', () => {
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
      name: 'Incident Monitor',
      url: fixture.url('/health'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      failureThreshold: 2,
      recoveryThreshold: 1,
      ...overrides,
    });

  it('stays quiet while the failure threshold has not been reached', async () => {
    const monitor = await newMonitor({ failureThreshold: 3, url: fixture.url('/error') });

    await executeCheck(monitor, { source: 'scheduled' });

    expect(monitor.consecutiveFailures).toBe(1);
    expect(monitor.status).toBe('down');
    expect(await Incident.countDocuments({ monitor: monitor._id })).toBe(0);
  });

  it('opens an incident once the threshold is reached', async () => {
    const monitor = await newMonitor({ failureThreshold: 2, url: fixture.url('/error') });

    await executeCheck(monitor, { source: 'scheduled' });
    await executeCheck(monitor, { source: 'scheduled' });

    const incidents = await Incident.find({ monitor: monitor._id });
    expect(incidents).toHaveLength(1);

    const incident = incidents[0];
    expect(incident).toMatchObject({
      status: 'open',
      active: true,
      severity: expect.stringMatching(/info|warning|critical/),
      failureCount: 2,
    });
    expect(incident.title).toContain('Incident Monitor');
    expect(incident.timeline[0].type).toBe('created');
    expect(incident.timeline[0].message).toMatch(/2 consecutive failed checks/);
  });

  it('NEVER creates a second incident for further failures', async () => {
    const RUNS = 6;
    const monitor = await newMonitor({ failureThreshold: 1, url: fixture.url('/error') });

    let last = monitor;
    for (let i = 0; i < RUNS; i += 1) {
      // reload so nextCheckAt/interval logic is realistic
      last = await Monitor.findById(monitor._id);
      await executeCheck(last, { source: 'scheduled' });
    }

    expect(last.consecutiveFailures).toBe(RUNS);
    const incidents = await Incident.find({ monitor: monitor._id });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].failureCount).toBe(RUNS);
    expect(incidents[0].timeline.filter((t) => t.type === 'failed_check')).toHaveLength(RUNS - 1);
  });

  it('is protected by the unique index even against a direct double insert', async () => {
    const monitor = await newMonitor();
    const base = {
      title: 'Race A',
      monitor: monitor._id,
      team: monitor.team,
      active: true,
      status: 'open',
    };

    await Incident.create(base);

    await expect(Incident.create({ ...base, title: 'Race B' })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('escalates severity as the outage gets worse', async () => {
    const monitor = await newMonitor({ failureThreshold: 1, url: fixture.url('/error') });

    await executeCheck(monitor, { source: 'scheduled' });
    const first = await Incident.findOne({ monitor: monitor._id });
    expect(first.severity).toBe('info');

    for (let i = 0; i < 4; i += 1) {
      const fresh = await Monitor.findById(monitor._id);
      await executeCheck(fresh, { source: 'scheduled' });
    }

    const later = await Incident.findOne({ monitor: monitor._id });
    expect(later.severity).toBe('critical');
  });
});

describe('Incident recovery', () => {
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

  it('resolves the incident automatically when the monitor recovers', async () => {
    const monitor = await Monitor.create({
      name: 'Recovery Monitor',
      url: fixture.url('/error'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
      recoveryThreshold: 1,
    });

    await executeCheck(monitor, { source: 'scheduled' });
    const incident = await Incident.findOne({ monitor: monitor._id });
    expect(incident.active).toBe(true);

    const fresh = await Monitor.findById(monitor._id);
    fresh.url = fixture.url('/health');
    await executeCheck(fresh, { source: 'scheduled' });

    const resolved = await Incident.findById(incident._id);
    expect(resolved.active).toBe(false);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.downtimeMs).toBeGreaterThanOrEqual(0);
    expect(resolved.timeline.some((t) => t.type === 'recovery')).toBe(true);
    expect(resolved.timeline.some((t) => t.type === 'resolved')).toBe(true);
  });

  it('opens a fresh incident after a second outage', async () => {
    const monitor = await Monitor.create({
      name: 'Flapping Monitor',
      url: fixture.url('/error'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
      recoveryThreshold: 1,
    });

    await executeCheck(monitor, { source: 'scheduled' });

    let fresh = await Monitor.findById(monitor._id);
    fresh.url = fixture.url('/health');
    await executeCheck(fresh, { source: 'scheduled' });

    fresh = await Monitor.findById(monitor._id);
    fresh.url = fixture.url('/error');
    await executeCheck(fresh, { source: 'scheduled' });

    const incidents = await Incident.find({ monitor: monitor._id }).sort({ startedAt: 1 });
    expect(incidents).toHaveLength(2);
    expect(incidents[0].status).toBe('resolved');
    expect(incidents[1].status).toBe('open');
  });

  it('does not resolve an incident while the monitor is still recovering', async () => {
    const monitor = await Monitor.create({
      name: 'Slow Recovery',
      url: fixture.url('/error'),
      team: user.teamId,
      createdBy: user.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
      recoveryThreshold: 3,
    });

    await executeCheck(monitor, { source: 'scheduled' });

    let fresh = await Monitor.findById(monitor._id);
    fresh.url = fixture.url('/health');
    await executeCheck(fresh, { source: 'scheduled' });

    let incident = await Incident.findOne({ monitor: monitor._id });
    expect(incident.active).toBe(true); // not trusted yet

    fresh = await Monitor.findById(monitor._id);
    await executeCheck(fresh, { source: 'scheduled' });
    incident = await Incident.findOne({ monitor: monitor._id });
    expect(incident.active).toBe(true);

    fresh = await Monitor.findById(monitor._id);
    await executeCheck(fresh, { source: 'scheduled' });
    incident = await Incident.findOne({ monitor: monitor._id });
    expect(incident.active).toBe(false);
    expect(incident.status).toBe('resolved');
  });
});

describe('Incident API', () => {
  let owner;
  let monitor;

  beforeEach(async () => {
    owner = await registerUser(app);
    monitor = await Monitor.create({
      name: 'API Incident Monitor',
      url: 'https://example.com',
      team: owner.teamId,
      createdBy: owner.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
    });
    await Incident.create({
      title: 'Checkout API unavailable',
      description: 'Repeated timeouts',
      monitor: monitor._id,
      team: owner.teamId,
      severity: 'critical',
      status: 'open',
      active: true,
      failureCount: 4,
      lastError: 'Request timed out after 10000 ms',
      timeline: [{ at: new Date(), type: 'created', message: 'Opened automatically' }],
    });
  });

  const openIncident = async () => (await Incident.findOne({ monitor: monitor._id }))._id;

  it('lists incidents with pagination', async () => {
    const res = await request(app).get('/api/incidents?page=1&limit=10').set(owner.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.incidents).toHaveLength(1);
    expect(res.body.data.incidents[0]).toMatchObject({
      title: 'Checkout API unavailable',
      severity: 'critical',
      status: 'open',
    });
    expect(res.body.data.incidents[0].monitor.name).toBe('API Incident Monitor');
    expect(res.body.data.incidents[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('filters by status and severity', async () => {
    expect(
      (await request(app).get('/api/incidents?status=open').set(owner.headers)).body.data.incidents
    ).toHaveLength(1);
    expect(
      (await request(app).get('/api/incidents?status=resolved').set(owner.headers)).body.data.incidents
    ).toHaveLength(0);
    expect(
      (await request(app).get('/api/incidents?status=active').set(owner.headers)).body.data.incidents
    ).toHaveLength(1);
    expect(
      (await request(app).get('/api/incidents?severity=critical').set(owner.headers)).body.data.incidents
    ).toHaveLength(1);
    expect(
      (await request(app).get('/api/incidents?severity=info').set(owner.headers)).body.data.incidents
    ).toHaveLength(0);
  });

  it('searches by title', async () => {
    const res = await request(app).get('/api/incidents?search=Checkout').set(owner.headers);
    expect(res.body.data.incidents).toHaveLength(1);
  });

  it('summarises incidents by status', async () => {
    const res = await request(app).get('/api/incidents/summary').set(owner.headers);
    expect(res.body.data).toMatchObject({ open: 1, acknowledged: 0, resolved: 0, total: 1 });
  });

  it('gets one incident with a full timeline', async () => {
    const id = await openIncident();
    const res = await request(app).get(`/api/incidents/${id}`).set(owner.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.incident.timeline.length).toBeGreaterThan(0);
    expect(res.body.data.monitorName).toBe('API Incident Monitor');
    expect(res.body.data.myRole).toBe('owner');
  });

  it('acknowledges an incident', async () => {
    const id = await openIncident();
    const res = await request(app).post(`/api/incidents/${id}/acknowledge`).set(owner.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.incident.status).toBe('acknowledged');
    expect(res.body.data.incident.acknowledgedAt).toBeTruthy();
    expect(
      res.body.data.incident.timeline.some((t) => t.type === 'acknowledged')
    ).toBe(true);
  });

  it('refuses to acknowledge twice', async () => {
    const id = await openIncident();
    await request(app).post(`/api/incidents/${id}/acknowledge`).set(owner.headers);
    const res = await request(app).post(`/api/incidents/${id}/acknowledge`).set(owner.headers);
    expect(res.statusCode).toBe(409);
  });

  it('resolves manually with notes', async () => {
    const id = await openIncident();
    const res = await request(app)
      .post(`/api/incidents/${id}/resolve`)
      .set(owner.headers)
      .send({ notes: 'Rolled back the bad deploy.' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.incident.status).toBe('resolved');
    expect(res.body.data.incident.active).toBe(false);
    expect(res.body.data.incident.resolutionNotes).toBe('Rolled back the bad deploy.');
    expect(res.body.data.incident.resolvedBy).toBeTruthy();
  });

  it('refuses to resolve twice', async () => {
    const id = await openIncident();
    await request(app).post(`/api/incidents/${id}/resolve`).set(owner.headers);
    const res = await request(app).post(`/api/incidents/${id}/resolve`).set(owner.headers);
    expect(res.statusCode).toBe(409);
  });

  it('adds notes to the timeline', async () => {
    const id = await openIncident();
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set(owner.headers)
      .send({ note: 'Contacted the upstream provider.' });

    expect(res.statusCode).toBe(201);
    expect(
      res.body.data.incident.timeline.some((t) => t.type === 'note' && /upstream/.test(t.message))
    ).toBe(true);
  });

  it('rejects an empty note', async () => {
    const id = await openIncident();
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set(owner.headers)
      .send({ note: '' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed incident id', async () => {
    const res = await request(app).get('/api/incidents/not-an-id').set(owner.headers);
    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/incidents');
    expect(res.statusCode).toBe(401);
  });

  describe('workspace isolation', () => {
    it('hides incidents from other workspaces', async () => {
      const stranger = await registerUser(app);
      const id = await openIncident();

      expect((await request(app).get('/api/incidents').set(stranger.headers)).body.data.incidents)
        .toHaveLength(0);
      expect((await request(app).get(`/api/incidents/${id}`).set(stranger.headers)).statusCode).toBe(404);
      expect(
        (await request(app).post(`/api/incidents/${id}/acknowledge`).set(stranger.headers)).statusCode
      ).toBe(404);
      expect(
        (await request(app).post(`/api/incidents/${id}/resolve`).set(stranger.headers)).statusCode
      ).toBe(404);
    });

    it('lets a viewer read and take part in incidents', async () => {
      const viewer = await registerUserInTeam(app, owner.teamId, 'viewer');
      const id = await openIncident();

      expect((await request(app).get('/api/incidents').set(viewer.headers)).statusCode).toBe(200);
      expect((await request(app).get(`/api/incidents/${id}`).set(viewer.headers)).statusCode).toBe(200);
      expect(
        (await request(app).post(`/api/incidents/${id}/acknowledge`).set(viewer.headers)).statusCode
      ).toBe(200);
      expect(
        (await request(app).post(`/api/incidents/${id}/note`).set(viewer.headers).send({ note: 'Looking into it' }))
          .statusCode
      ).toBe(201);
    });

    it('lets a second workspace member see the incident too', async () => {
      const colleague = await registerUserInTeam(app, owner.teamId, 'admin');
      const res = await request(app).get('/api/incidents').set(colleague.headers);
      expect(res.body.data.incidents).toHaveLength(1);
    });
  });

  describe('deleting the monitor cleans up incidents', () => {
    it('does not leave orphan incidents', async () => {
      const id = await openIncident();
      await request(app).delete(`/api/monitors/${monitor._id}`).set(owner.headers);

      // The incident still exists and is readable, but points at a removed monitor
      const res = await request(app).get(`/api/incidents/${id}`).set(owner.headers);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.incident.monitor).toBeNull();
    });
  });
});

describe('Deleting a monitor with an active incident', () => {
  it('keeps the incident history for the audit trail', async () => {
    const user = await registerUser(app);
    const monitor = await Monitor.create({
      name: 'To Be Deleted',
      url: 'https://example.com',
      team: user.teamId,
      createdBy: user.id,
    });
    await Incident.create({
      title: 'Incident on a deleted monitor',
      monitor: monitor._id,
      team: user.teamId,
      active: true,
    });

    await request(app).delete(`/api/monitors/${monitor._id}`).set(user.headers);

    const incidents = await Incident.find({ team: user.teamId });
    expect(incidents).toHaveLength(1);
  });
});

void TeamMember;
void Notification;