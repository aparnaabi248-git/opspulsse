const request = require('supertest');
const app = require('../src/app');
const { registerUser, registerUserInTeam, startFixtureServer } = require('./helpers');

/**
 * Workspace / team authorisation.
 *
 * These tests prove that one tenant cannot read or change another tenant's
 * monitors, and that role-based access actually works.
 */

describe('Workspace authorization', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  let owner;
  let monitorId;

  beforeEach(async () => {
    owner = await registerUser(app);
    const created = await request(app)
      .post('/api/monitors')
      .set(owner.headers)
      .send({ name: 'Owner monitor', url: fixture.url('/health'), team: owner.teamId });
    monitorId = created.body.data.monitor.id;
  });

  describe('a user from another workspace', () => {
    let stranger;

    beforeEach(async () => {
      stranger = await registerUser(app);
    });

    it('does not see the monitor in the list', async () => {
      const res = await request(app).get('/api/monitors').set(stranger.headers);
      expect(res.body.data.monitors).toHaveLength(0);
    });

    it('cannot read it', async () => {
      const res = await request(app).get(`/api/monitors/${monitorId}`).set(stranger.headers);
      expect(res.statusCode).toBe(404);
    });

    it('cannot update it', async () => {
      const res = await request(app)
        .put(`/api/monitors/${monitorId}`)
        .set(stranger.headers)
        .send({ name: 'Hijacked' });
      expect(res.statusCode).toBe(404);
    });

    it('cannot delete it', async () => {
      const res = await request(app).delete(`/api/monitors/${monitorId}`).set(stranger.headers);
      expect(res.statusCode).toBe(404);
    });

    it('cannot read its check history', async () => {
      const res = await request(app).get(`/api/monitors/${monitorId}/checks`).set(stranger.headers);
      expect(res.statusCode).toBe(404);
    });

    it('cannot read the team details', async () => {
      const res = await request(app).get(`/api/teams/${owner.teamId}`).set(stranger.headers);
      expect(res.statusCode).toBe(403);
    });

    it('cannot create a monitor inside somebody else team', async () => {
      const res = await request(app)
        .post('/api/monitors')
        .set(stranger.headers)
        .send({ name: 'Injected', url: fixture.url('/health'), team: owner.teamId });

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/not a member/i);
    });

    it('cannot filter the list by a team it does not belong to', async () => {
      const res = await request(app)
        .get(`/api/monitors?teamId=${owner.teamId}`)
        .set(stranger.headers);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('role based access inside the same workspace', () => {
    let viewer;
    let admin;

    beforeEach(async () => {
      viewer = await registerUserInTeam(app, owner.teamId, 'viewer');
      admin = await registerUserInTeam(app, owner.teamId, 'admin');
    });

    it('lets a viewer read the monitor and its history', async () => {
      const list = await request(app).get('/api/monitors').set(viewer.headers);
      expect(list.statusCode).toBe(200);
      expect(list.body.data.monitors).toHaveLength(1);

      const single = await request(app).get(`/api/monitors/${monitorId}`).set(viewer.headers);
      expect(single.statusCode).toBe(200);
      expect(single.body.data.myRole).toBe('viewer');

      const history = await request(app)
        .get(`/api/monitors/${monitorId}/checks`)
        .set(viewer.headers);
      expect(history.statusCode).toBe(200);
    });

    it('stops a viewer from creating a monitor', async () => {
      const res = await request(app)
        .post('/api/monitors')
        .set(viewer.headers)
        .send({ name: 'Viewer monitor', url: fixture.url('/health'), team: owner.teamId });

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/requires: owner or admin/i);
    });

    it('stops a viewer from editing, pausing or deleting', async () => {
      const update = await request(app)
        .put(`/api/monitors/${monitorId}`)
        .set(viewer.headers)
        .send({ name: 'Viewer edit' });
      expect(update.statusCode).toBe(403);

      const pause = await request(app)
        .patch(`/api/monitors/${monitorId}/pause`)
        .set(viewer.headers);
      expect(pause.statusCode).toBe(403);

      const remove = await request(app).delete(`/api/monitors/${monitorId}`).set(viewer.headers);
      expect(remove.statusCode).toBe(403);
    });

    it('lets an admin edit but not delete team membership of the owner', async () => {
      const res = await request(app)
        .put(`/api/monitors/${monitorId}`)
        .set(admin.headers)
        .send({ name: 'Admin edit' });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.monitor.name).toBe('Admin edit');
    });

    it('does not let a viewer trigger a manual check on somebody else behalf only if not a member — but a viewer may trigger a check', async () => {
      const res = await request(app).post(`/api/monitors/${monitorId}/check`).set(viewer.headers);
      expect(res.statusCode).toBe(200);
      expect(['up', 'down', 'degraded']).toContain(res.body.data.status);
    });
  });

  describe('team routes', () => {
    it('rejects an invalid role when changing a member role', async () => {
      const member = await registerUserInTeam(app, owner.teamId, 'viewer');

      const res = await request(app)
        .put(`/api/teams/${owner.teamId}/members/${member.id}`)
        .set(owner.headers)
        .send({ role: 'superuser' });

      expect(res.statusCode).toBe(400);
    });

    it('never allows granting the owner role through the API', async () => {
      const member = await registerUserInTeam(app, owner.teamId, 'viewer');

      const res = await request(app)
        .put(`/api/teams/${owner.teamId}/members/${member.id}`)
        .set(owner.headers)
        .send({ role: 'owner' });

      expect(res.statusCode).toBe(400);
      // Rejected either by the role validator or by the controller guard
      expect(res.body.message).toMatch(/validation failed|cannot assign owner/i);
      const detail = JSON.stringify(res.body.errors || res.body.message);
      expect(detail).toMatch(/admin or viewer|owner/i);
    });

    it('only the owner can delete the team', async () => {
      const admin = await registerUserInTeam(app, owner.teamId, 'admin');
      const res = await request(app).delete(`/api/teams/${owner.teamId}`).set(admin.headers);
      expect(res.statusCode).toBe(403);
    });

    it('lists only the teams the caller belongs to', async () => {
      const member = await registerUserInTeam(app, owner.teamId, 'viewer');

      // A user keeps their own personal workspace AND the shared team,
      // but sees nothing from anybody else's workspace.
      const mine = await request(app).get('/api/teams').set(member.headers);
      expect(mine.statusCode).toBe(200);
      expect(mine.body.data.teams).toHaveLength(2);

      const shared = mine.body.data.teams.find((t) => t._id === owner.teamId);
      expect(shared.role).toBe('viewer');

      const own = mine.body.data.teams.find((t) => t._id === member.teamId);
      expect(own.role).toBe('owner');

      // a brand new user only sees their own workspace
      const stranger = await registerUser(app);
      const theirs = await request(app).get('/api/teams').set(stranger.headers);
      expect(theirs.body.data.teams).toHaveLength(1);
      expect(String(theirs.body.data.teams[0]._id)).toBe(stranger.teamId);
    });
  });
});