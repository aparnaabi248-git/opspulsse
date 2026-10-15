const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const ApiError = require('../src/utils/ApiError');
const errorHandler = require('../src/middleware/errorHandler');
const { registerUser } = require('./helpers');

/**
 * API error handling and edge cases.
 */

describe('Unknown routes', () => {
  it('returns a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      success: false,
      message: 'Route GET /api/does-not-exist not found',
    });
  });
});

describe('Malformed requests', () => {
  it('returns 400 for invalid JSON', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "broken",,,}');

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/not valid JSON/i);
  });

  it('returns 404 (not 500) for a non-ObjectId monitor id', async () => {
    const user = await registerUser(app);
    const res = await request(app).get('/api/monitors/not-an-object-id').set(user.headers);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown but valid ObjectId', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .get('/api/monitors/64b7f1c2a1b2c3d4e5f60718')
      .set(user.headers);
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for an invalid ObjectId on a team route', async () => {
    const user = await registerUser(app);
    const res = await request(app).get('/api/teams/not-an-id').set(user.headers);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Invalid value/i);
  });
});

describe('Health endpoints', () => {
  it('/api/health is public and does not need a database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.uptime).toBe('number');
  });

  it('/api/ready reports the database connection', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.statusCode).toBe(200);
    expect(res.body.database).toBe('connected');
  });
});

describe('errorHandler unit tests', () => {
  const run = (err, nodeEnv = 'test') => {
    const original = config.nodeEnv;
    config.nodeEnv = nodeEnv;
    const req = { method: 'GET', originalUrl: '/api/test' };
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    errorHandler(err, req, res, () => {});
    config.nodeEnv = original;
    return res;
  };

  it('passes through an ApiError status and message', () => {
    const res = run(new ApiError(404, 'Monitor not found.'));
    expect(res.code).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Monitor not found.' });
  });

  it('converts a Mongoose ValidationError into field errors', () => {
    const err = new Error('Validation failed');
    err.name = 'ValidationError';
    err.errors = { name: { path: 'name', message: 'Name is required' } };

    const res = run(err);
    expect(res.code).toBe(400);
    expect(res.body.errors).toEqual([{ field: 'name', message: 'Name is required' }]);
  });

  it('turns a duplicate key error into 409', () => {
    const err = Object.assign(new Error('E11000'), {
      code: 11000,
      keyValue: { email: 'dupe@example.com' },
    });

    const res = run(err);
    expect(res.code).toBe(409);
    expect(res.body.message).toMatch(/email/);
  });

  it('explains the one-active-incident index violation', () => {
    const err = Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { monitor: 1, active: 1 },
      keyValue: { monitor: 'x', active: true },
    });

    const res = run(err);
    expect(res.code).toBe(409);
    expect(res.body.message).toMatch(/already has an active incident/i);
  });

  it('never leaks a stack trace in production', () => {
    const res = run(new Error('internal database secret leaked here'), 'production');
    expect(res.code).toBe(500);
    expect(res.body.stack).toBeUndefined();
    expect(res.body.message).toBe('internal database secret leaked here');
  });

  it('maps an SSRF block to 400', () => {
    const err = Object.assign(new Error('localhost is not allowed'), { code: 'SSRF_BLOCKED' });
    const res = run(err);
    expect(res.code).toBe(400);
  });
});

describe('Validation error shape', () => {
  it('always returns an errors array with field and message', async () => {
    const res = await request(app).post('/api/auth/register').send({});

    expect(res.statusCode).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    for (const e of res.body.errors) {
      expect(typeof e.field).toBe('string');
      expect(typeof e.message).toBe('string');
    }
  });
});

describe('Security headers', () => {
  it('sends helmet headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Rate limiting protects sign-in without locking people out', () => {
  const express = require('express');
  const { createLimiters } = require('../src/middleware/rateLimit');
  const { authLimiter } = createLimiters({ authMax: 3, windowMs: 60_000 });

  const miniApp = express();
  miniApp.use(express.json());
  miniApp.post('/login', authLimiter, (req, res) => {
    // Stand-in for the real controller: 200 = success, 401 = bad password
    if (req.body.password === 'Password123') return res.json({ success: true });
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  });

  it('counts failed attempts but not successful ones', async () => {
    // 6 successful logins must NOT exhaust the budget of 3
    for (let i = 0; i < 6; i += 1) {
      const res = await request(miniApp).post('/login').send({ password: 'Password123' });
      expect(res.statusCode).toBe(200);
    }

    // 3 failures are allowed
    for (let i = 0; i < 3; i += 1) {
      const res = await request(miniApp).post('/login').send({ password: 'wrong' });
      expect(res.statusCode).toBe(401);
    }

    // The 4th failure trips the limit
    const blocked = await request(miniApp).post('/login').send({ password: 'wrong' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.message).toMatch(/Too many failed sign-in attempts/i);
  });

  it('sends standard rate limit headers', async () => {
    const res = await request(miniApp).post('/login').send({ password: 'Password123' });
    // Already rate limited from the previous test in this file
    expect(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit']).toBeDefined();
  });
});