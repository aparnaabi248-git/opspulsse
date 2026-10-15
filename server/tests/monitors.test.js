const request = require('supertest');
const app = require('../src/app');
const { registerUser, startFixtureServer } = require('./helpers');

/**
 * Monitor CRUD through the real API, including a real health check.
 */

describe('Monitor CRUD', () => {
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

  it('creates a monitor with defaults', async () => {
    const res = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'My API', url: fixture.url('/health'), team: user.teamId });

    expect(res.statusCode).toBe(201);
    const m = res.body.data.monitor;
    expect(m).toMatchObject({
      name: 'My API',
      method: 'GET',
      status: 'pending',
      expectedStatusCodes: [200],
      isPaused: false,
    });
    expect(m.url).toBe(fixture.url('/health'));
  });

  it('normalises a bare domain into a full URL', async () => {
    const res = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Bare domain', url: 'https://example.com/health', team: user.teamId });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.monitor.url).toBe('https://example.com/health');
  });

  it('accepts a custom method, interval and timeout', async () => {
    const res = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({
        name: 'POST API',
        url: fixture.url('/health'),
        team: user.teamId,
        method: 'post',
        intervalSeconds: 120,
        timeoutMs: 5000,
        expectedStatusCodes: [200, 201],
        degradedThresholdMs: 2000,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.monitor).toMatchObject({
      method: 'POST',
      intervalSeconds: 120,
      timeoutMs: 5000,
      expectedStatusCodes: [200, 201],
    });
  });

  it.each([
    ['missing name', { team: 'TEAM', url: 'https://example.com' }, 'name'],
    ['missing url', { team: 'TEAM', name: 'No URL' }, 'url'],
    ['missing team', { name: 'No team', url: 'https://example.com' }, 'team'],
    ['interval below the safe limit', { name: 'Too fast', url: 'https://example.com', intervalSeconds: 1 }, 'intervalSeconds'],
    ['timeout above the safe limit', { name: 'Too slow', url: 'https://example.com', timeoutMs: 999999 }, 'timeoutMs'],
    ['unsupported method', { name: 'Bad method', url: 'https://example.com', method: 'TRACE' }, 'method'],
    ['blank name', { name: '   ', url: 'https://example.com' }, 'name'],
  ])('rejects %s with 400', async (_label, extra, field) => {
    const payload = { ...extra, team: extra.team === 'TEAM' ? user.teamId : extra.team };

    const res = await request(app).post('/api/monitors').set(user.headers).send(payload);

    expect(res.statusCode).toBe(400);
    expect(res.body.errors.some((e) => e.field === field)).toBe(true);
  });

  it('lists monitors with pagination metadata', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/monitors')
        .set(user.headers)
        .send({ name: `Monitor ${i}`, url: fixture.url('/health'), team: user.teamId });
    }

    const res = await request(app)
      .get('/api/monitors?page=1&limit=2')
      .set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.monitors).toHaveLength(2);
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('filters the list by status', async () => {
    await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Healthy', url: fixture.url('/health'), team: user.teamId });
    await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Broken', url: fixture.url('/error'), team: user.teamId });

    const all = await request(app).get('/api/monitors').set(user.headers);
    expect(all.body.data.monitors).toHaveLength(2);

    const res = await request(app).get('/api/monitors?search=Broken').set(user.headers);
    expect(res.body.data.monitors).toHaveLength(1);
    expect(res.body.data.monitors[0].name).toBe('Broken');
  });

  it('gets a single monitor', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Single', url: fixture.url('/health'), team: user.teamId });

    const res = await request(app).get(`/api/monitors/${created.body.data.monitor.id}`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.monitor.name).toBe('Single');
    expect(res.body.data.myRole).toBe('owner');
  });

  it('updates a monitor', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Before', url: fixture.url('/health'), team: user.teamId });
    const id = created.body.data.monitor.id;

    const res = await request(app)
      .put(`/api/monitors/${id}`)
      .set(user.headers)
      .send({ name: 'After', intervalSeconds: 90 });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.monitor).toMatchObject({ name: 'After', intervalSeconds: 90 });
  });

  it('rejects an empty update', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Before', url: fixture.url('/health'), team: user.teamId });

    const res = await request(app)
      .put(`/api/monitors/${created.body.data.monitor.id}`)
      .set(user.headers)
      .send({});

    expect(res.statusCode).toBe(400);
  });

  it('pauses and resumes, restoring the previous status', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Pausable', url: fixture.url('/health'), team: user.teamId });
    const id = created.body.data.monitor.id;

    await request(app).post(`/api/monitors/${id}/check`).set(user.headers);

    const paused = await request(app).patch(`/api/monitors/${id}/pause`).set(user.headers);
    expect(paused.statusCode).toBe(200);
    expect(paused.body.data.monitor.status).toBe('paused');
    expect(paused.body.data.monitor.isPaused).toBe(true);

    const resumed = await request(app).patch(`/api/monitors/${id}/resume`).set(user.headers);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body.data.monitor.status).toBe('up');
    expect(resumed.body.data.monitor.isPaused).toBe(false);
  });

  it('refuses to pause an already paused monitor', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Pausable', url: fixture.url('/health'), team: user.teamId });
    const id = created.body.data.monitor.id;

    await request(app).patch(`/api/monitors/${id}/pause`).set(user.headers);
    const res = await request(app).patch(`/api/monitors/${id}/pause`).set(user.headers);

    expect(res.statusCode).toBe(409);
  });

  it('runs a real manual check and stores the result', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Checkable', url: fixture.url('/health'), team: user.teamId });
    const id = created.body.data.monitor.id;

    const res = await request(app).post(`/api/monitors/${id}/check`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('up');
    expect(res.body.data.statusCode).toBe(200);
    expect(res.body.data.checkResult.outcome).toBe('ok');
    expect(res.body.data.checkResult.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(res.body.data.monitor.lastCheckAt).toBeTruthy();
    expect(res.body.data.monitor.totals.checks).toBe(1);
  });

  it('records a real DOWN status when the target fails', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Broken', url: fixture.url('/error'), team: user.teamId });
    const id = created.body.data.monitor.id;

    const res = await request(app).post(`/api/monitors/${id}/check`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('down');
    expect(res.body.data.monitor.consecutiveFailures).toBe(1);
    expect(res.body.data.monitor.lastError).toMatch(/Unexpected status code 500/);
  });

  it('returns check history, newest first, with pagination', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'History', url: fixture.url('/health'), team: user.teamId });
    const id = created.body.data.monitor.id;

    await request(app).post(`/api/monitors/${id}/check`).set(user.headers);
    await request(app).post(`/api/monitors/${id}/check`).set(user.headers);

    const res = await request(app).get(`/api/monitors/${id}/checks?page=1&limit=1`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.checks).toHaveLength(1);
    expect(res.body.data.pagination.total).toBe(2);
    expect(res.body.data.checks[0].source).toBe('manual');
  });

  it('deletes a monitor together with its check history', async () => {
    const CheckResult = require('../src/models/CheckResult');
    const created = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Deletable', url: fixture.url('/health'), team: user.teamId });
    const id = created.body.data.monitor.id;

    await request(app).post(`/api/monitors/${id}/check`).set(user.headers);
    expect(await CheckResult.countDocuments({ monitor: id })).toBe(1);

    const res = await request(app).delete(`/api/monitors/${id}`).set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(await CheckResult.countDocuments({ monitor: id })).toBe(0);

    const after = await request(app).get(`/api/monitors/${id}`).set(user.headers);
    expect(after.statusCode).toBe(404);
  });
});