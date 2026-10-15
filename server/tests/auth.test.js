const request = require('supertest');
const app = require('../src/app');
const { registerUser } = require('./helpers');

/**
 * Registration and login — exercised through the real HTTP API.
 */

describe('POST /api/auth/register', () => {
  it('creates a user, a personal team and returns a JWT', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Arun Kumar',
      email: 'arun@example.com',
      password: 'Password123',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      name: 'Arun Kumar',
      email: 'arun@example.com',
    });
    expect(res.body.data.user).not.toHaveProperty('password');
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.team.id).toBeTruthy();
  });

  it('never stores the password in plain text', async () => {
    const User = require('../src/models/User');
    await registerUser(app);

    const stored = await User.findOne({ email: /user\d+@example\.com/ }).select('+password');
    expect(stored.password).not.toBe('Password123');
    expect(stored.password).toMatch(/^\$2[aby]\$/); // bcrypt hash
  });

  it('rejects a duplicate email with 409', async () => {
    const payload = { name: 'First User', email: 'dupe@example.com', password: 'Password123' };
    await request(app).post('/api/auth/register').send(payload);

    const res = await request(app).post('/api/auth/register').send(payload);
    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ['missing name', { email: 'a@b.com', password: 'Password123' }, 'name'],
    ['invalid email', { name: 'Valid Name', email: 'not-an-email', password: 'Password123' }, 'email'],
    ['short password', { name: 'Valid Name', email: 'x@y.com', password: 'Pass1' }, 'password'],
    ['password without a number', { name: 'Valid Name', email: 'x@y.com', password: 'PasswordOnly' }, 'password'],
    ['password without a letter', { name: 'Valid Name', email: 'x@y.com', password: '12345678' }, 'password'],
  ])('rejects %s with 400 and field errors', async (_label, payload, field) => {
    const res = await request(app).post('/api/auth/register').send(payload);
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors.some((e) => e.field === field)).toBe(true);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token for correct credentials', async () => {
    const user = await registerUser(app);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.teams).toHaveLength(1);
    expect(res.body.data.teams[0].role).toBe('owner');
  });

  it('rejects a wrong password with 401', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'WrongPassword1' });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
  });

  it('gives the same message for an unknown email (no user enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'Password123' });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
  });
});

describe('Protected routes', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/Authentication required/i);
  });

  it('rejects a forged/garbage token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.statusCode).toBe(401);
  });

  it('returns the profile and teams for a valid token', async () => {
    const user = await registerUser(app);
    const res = await request(app).get('/api/auth/me').set(user.headers);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.user).not.toHaveProperty('password');
    expect(res.body.data.teams).toHaveLength(1);
  });
});

describe('Profile management', () => {
  it('updates the name', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .put('/api/auth/profile')
      .set(user.headers)
      .send({ name: 'New Name' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.user.name).toBe('New Name');
  });

  it('refuses an email that belongs to somebody else', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);

    const res = await request(app)
      .put('/api/auth/profile')
      .set(a.headers)
      .send({ email: b.email });

    expect(res.statusCode).toBe(409);
  });

  it('changes the password and the new one works for login', async () => {
    const user = await registerUser(app);

    const change = await request(app)
      .put('/api/auth/change-password')
      .set(user.headers)
      .send({ currentPassword: user.password, newPassword: 'BrandNewPass9' });

    expect(change.statusCode).toBe(200);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'BrandNewPass9' });

    expect(login.statusCode).toBe(200);
  });

  it('refuses a password change with the wrong current password', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .put('/api/auth/change-password')
      .set(user.headers)
      .send({ currentPassword: 'NotMyPassword1', newPassword: 'BrandNewPass9' });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the auth cookie', async () => {
    const user = await registerUser(app);
    const res = await request(app).post('/api/auth/logout').set(user.headers);

    expect(res.statusCode).toBe(200);
    const cookie = res.headers['set-cookie'] || [];
    expect(cookie.join(';')).toMatch(/token=;/);
  });
});