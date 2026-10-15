const http = require('http');
const request = require('supertest');

/**
 * Shared test helpers.
 */

// ── Users / auth ─────────────────────────────────────────────────────

let userCounter = 0;

/** Register a fresh user through the real API. */
const registerUser = async (app, overrides = {}) => {
  userCounter += 1;
  const payload = {
    name: `Test User ${userCounter}`,
    email: `user${userCounter}@example.com`,
    password: 'Password123',
    ...overrides,
  };

  const res = await request(app).post('/api/auth/register').send(payload);
  if (res.statusCode !== 201) {
    throw new Error(`registerUser failed (${res.statusCode}): ${JSON.stringify(res.body)}`);
  }

  return {
    ...payload,
    id: res.body.data.user.id,
    token: res.body.data.token,
    teamId: res.body.data.team.id,
    headers: { Authorization: `Bearer ${res.body.data.token}` },
  };
};

/** Register a user and add them to an existing team with a given role. */
const registerUserInTeam = async (app, teamId, role = 'viewer') => {
  const TeamMember = require('../src/models/TeamMember');
  const user = await registerUser(app);
  await TeamMember.create({ team: teamId, user: user.id, role });
  return user;
};

// ── Monitors ─────────────────────────────────────────────────────────

/** Create a monitor through the API and return the created document. */
const createMonitor = async (app, user, overrides = {}) => {
  const payload = {
    name: `Test Monitor ${Math.random().toString(36).slice(2, 8)}`,
    url: 'https://example.com',
    team: user.teamId,
    ...overrides,
  };

  const res = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${user.token}`)
    .send(payload);

  return res;
};

// ── HTTP fixture server ──────────────────────────────────────────────

/**
 * Starts a real local HTTP server used by the health-check tests.
 *
 * Endpoints:
 *   /health    -> 200 {"status":"ok"}
 *   /text      -> 200 "Everything is fine"
 *   /slow      -> 200 after ?ms= delay
 *   /hang      -> never responds (used for the timeout test)
 *   /error     -> 500
 *   /redirect  -> 302 to ?to=
 *   /reset     -> destroys the socket (connection reset test)
 *   /wrong     -> 404
 */
const startFixtureServer = async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    switch (url.pathname) {
      case '/health':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));

      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('Everything is fine');

      case '/slow': {
        const delay = parseInt(url.searchParams.get('ms') || '500', 10);
        return setTimeout(() => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('slow but ok');
        }, delay);
      }

      case '/hang':
        // deliberately never responds
        return undefined;

      case '/error':
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('Internal Server Error');

      case '/wrong':
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not Found');

      case '/redirect': {
        const to = url.searchParams.get('to') || '/health';
        res.writeHead(302, { location: to });
        return res.end();
      }

      case '/reset':
        return req.socket.destroy();

      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('fixture ok');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    url: (path) => `${baseUrl}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
};

module.exports = { registerUser, registerUserInTeam, createMonitor, startFixtureServer };