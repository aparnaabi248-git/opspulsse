const http = require('http');
const { io: ioClient } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../src/app');
const config = require('../src/config');
const { initSocket, closeSocket } = require('../src/socket');
const Monitor = require('../src/models/Monitor');
const Notification = require('../src/models/Notification');
const TeamMember = require('../src/models/TeamMember');
const { registerUser, registerUserInTeam, startFixtureServer } = require('./helpers');
const { executeCheck } = require('../src/services/monitorService');

/**
 * Socket.IO real-time layer.
 *
 * These tests prove the two things that matter:
 *   1. an unauthenticated socket is refused
 *   2. a socket only ever receives events for teams it belongs to
 */

let server;
let port;
let fixture;

/**
 * Connect and wait for the server's `connection:ready` handshake, so the
 * event cannot be missed and the rooms are guaranteed to be joined before the
 * test emits anything.
 */
const connect = (options = {}) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 5000,
      ...options,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out waiting for connection:ready'));
    }, 8000);

    socket.once('connection:ready', (ready) => {
      clearTimeout(timer);
      resolve({ socket, ready });
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const nextEvent = (socket, event, timeout = 6000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

beforeAll(async () => {
  fixture = await startFixtureServer();
  server = http.createServer(app);
  initSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await closeSocket();
  await new Promise((resolve) => server.close(resolve));
  await fixture.close();
});

describe('Socket authentication', () => {
  it('refuses a socket with no token', async () => {
    await expect(connect()).rejects.toThrow(/Authentication required/);
  });

  it('refuses a socket with a forged token', async () => {
    await expect(connect({ auth: { token: 'not.a.real.jwt' } })).rejects.toThrow(
      /Invalid authentication token/
    );
  });

  it('refuses a socket for a deleted account', async () => {
    const user = await registerUser(app);
    const token = jwt.sign({ id: new mongoose.Types.ObjectId().toString() }, config.jwt.secret);

    await expect(connect({ auth: { token } })).rejects.toThrow(/no longer exists/);
    expect(user.id).toBeTruthy();
  });

  it('accepts a valid token and reports the team rooms', async () => {
    const user = await registerUser(app);
    const token = jwt.sign({ id: user.id }, config.jwt.secret);

    const { socket, ready } = await connect({ auth: { token } });
    expect(ready.user.id).toBe(user.id);
    expect(ready.teamIds).toContain(String(user.teamId));
    socket.close();
  });
});

describe('Room isolation', () => {
  it('delivers monitor:status only to members of the owning team', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);

    const monitor = await Monitor.create({
      name: 'Room Test Monitor',
      url: fixture.url('/error'),
      team: owner.teamId,
      createdBy: owner.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
    });

    const ownerToken = jwt.sign({ id: owner.id }, config.jwt.secret);
    const strangerToken = jwt.sign({ id: stranger.id }, config.jwt.secret);

    const { socket: ownerSocket } = await connect({ auth: { token: ownerToken } });
    const { socket: strangerSocket } = await connect({ auth: { token: strangerToken } });

    // The stranger must NOT get this event
    let leaked = false;
    strangerSocket.on('monitor:status', () => {
      leaked = true;
    });

    const statusPromise = nextEvent(ownerSocket, 'monitor:status');
    await executeCheck(monitor, { source: 'scheduled' });
    const payload = await statusPromise;

    expect(payload.monitorId).toBe(String(monitor._id));
    expect(payload.status).toBe('down');
    expect(payload.name).toBe('Room Test Monitor');

    await new Promise((r) => setTimeout(r, 600));
    expect(leaked).toBe(false);

    ownerSocket.close();
    strangerSocket.close();
  });

  it('sends monitor:check to every team member', async () => {
    const owner = await registerUser(app);
    const monitor = await Monitor.create({
      name: 'Activity Push Monitor',
      url: fixture.url('/health'),
      team: owner.teamId,
      createdBy: owner.id,
      degradedThresholdMs: 5000,
    });

    const { socket } = await connect({ auth: { token: jwt.sign({ id: owner.id }, config.jwt.secret) } });

    const checkPromise = nextEvent(socket, 'monitor:check');
    await executeCheck(monitor, { source: 'scheduled' });
    const payload = await checkPromise;

    expect(payload).toMatchObject({
      monitorId: String(monitor._id),
      name: 'Activity Push Monitor',
      status: 'up',
      source: 'scheduled',
    });
    expect(payload.responseTimeMs).toBeGreaterThanOrEqual(0);

    socket.close();
  });

  it('pushes notification:new to the private user room only', async () => {
    const owner = await registerUser(app);
    const colleague = await registerUserInTeam(app, owner.teamId, 'admin');
    const stranger = await registerUser(app);

    const monitor = await Monitor.create({
      name: 'Notification Push',
      url: 'https://example.com',
      team: owner.teamId,
      createdBy: owner.id,
    });

    const { socket: ownerSocket } = await connect({
      auth: { token: jwt.sign({ id: owner.id }, config.jwt.secret) },
    });
    const { socket: colleagueSocket } = await connect({
      auth: { token: jwt.sign({ id: colleague.id }, config.jwt.secret) },
    });
    const { socket: strangerSocket } = await connect({
      auth: { token: jwt.sign({ id: stranger.id }, config.jwt.secret) },
    });

    let strangerGotIt = false;
    strangerSocket.on('notification:new', () => {
      strangerGotIt = true;
    });

    const ownerPromise = nextEvent(ownerSocket, 'notification:new');
    const colleaguePromise = nextEvent(colleagueSocket, 'notification:new');

    const { notifyTeam } = require('../src/services/alertService');
    await notifyTeam({
      type: 'monitor_down',
      dedupeKey: `socket:test:${Date.now()}`,
      title: 'Down',
      message: 'The socket test monitor is down',
      severity: 'critical',
      team: owner.teamId,
      monitor: monitor._id,
    });

    const [ownerEvent, colleagueEvent] = await Promise.all([ownerPromise, colleaguePromise]);

    expect(ownerEvent.title).toBe('Down');
    expect(ownerEvent.read).toBe(false);
    expect(ownerEvent.id).toBeTruthy();
    expect(colleagueEvent.title).toBe('Down');

    await new Promise((r) => setTimeout(r, 600));
    expect(strangerGotIt).toBe(false);

    expect(await Notification.countDocuments({ user: stranger.id })).toBe(0);

    ownerSocket.close();
    colleagueSocket.close();
    strangerSocket.close();
  });

  it('broadcasts incident events to the team room', async () => {
    const owner = await registerUser(app);
    const monitor = await Monitor.create({
      name: 'Incident Socket Monitor',
      url: fixture.url('/error'),
      team: owner.teamId,
      createdBy: owner.id,
      degradedThresholdMs: 5000,
      failureThreshold: 1,
    });

    const { socket } = await connect({ auth: { token: jwt.sign({ id: owner.id }, config.jwt.secret) } });

    const incidentPromise = nextEvent(socket, 'incident:created');
    await executeCheck(monitor, { source: 'scheduled' });
    const incidentEvent = await incidentPromise;

    expect(incidentEvent.title).toContain('Incident Socket Monitor');
    expect(incidentEvent.severity).toMatch(/info|warning|critical/);
    expect(incidentEvent.status).toBe('open');

    socket.close();
  });

  it('does not crash when nothing is listening', async () => {
    // The emit helpers must be safe even when io is torn down
    const { emitToTeam, emitToUser } = require('../src/socket');
    expect(() => emitToTeam(new mongoose.Types.ObjectId(), 'test', {})).not.toThrow();
    expect(() => emitToUser(new mongoose.Types.ObjectId(), 'test', {})).not.toThrow();
    expect(() => emitToTeam(null, 'test', {})).not.toThrow();
  });
});

void TeamMember;