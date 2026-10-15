const dnsPromises = require('dns').promises;
const request = require('supertest');

const config = require('../src/config');
const {
  SSRFBlockedError,
  validateMonitorUrl,
  validateRedirect,
  isPrivateAddress,
  resolveAndValidateTarget,
} = require('../src/services/ssrfGuard');
const app = require('../src/app');
const { registerUser } = require('./helpers');

/**
 * SSRF protection.
 *
 * These tests run with ALLOW_PRIVATE_TARGETS switched OFF, exactly like
 * production, so the private-range blocking is genuinely exercised.
 */

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['127.255.255.254', 'IPv4 loopback edge'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC1918 private'],
    ['172.16.5.4', 'RFC1918 private'],
    ['172.31.255.255', 'RFC1918 private'],
    ['192.168.1.1', 'RFC1918 private'],
    ['169.254.169.254', 'AWS/Azure/GCP metadata'],
    ['100.100.100.200', 'Alibaba cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique local'],
    ['fd12:3456::1', 'IPv6 unique local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['2001:db8::1', 'documentation range'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'Google public DNS'],
    ['1.1.1.1', 'Cloudflare public DNS'],
    ['93.184.216.34', 'public website'],
    ['172.15.0.1', 'just below the private block'],
    ['172.32.0.1', 'just above the private block'],
    ['2606:4700::1111', 'public IPv6'],
    ['2001:4860:4860::8888', 'public IPv6 DNS'],
  ])('allows %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('validateMonitorUrl — schemes and hostnames', () => {
  beforeAll(() => {
    config.security.allowPrivateTargets = false;
  });
  afterAll(() => {
    config.security.allowPrivateTargets = true;
  });

  it.each([
    ['file:///etc/passwd', 'file scheme'],
    ['ftp://example.com', 'ftp scheme'],
    ['gopher://example.com', 'gopher scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['data:text/html,<h1>x', 'data scheme'],
  ])('rejects %s (%s)', async (url) => {
    await expect(validateMonitorUrl(url)).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(validateMonitorUrl('http://admin:secret@8.8.8.8/')).rejects.toThrow(
      /credentials/i
    );
  });

  it('rejects empty and malformed input', async () => {
    await expect(validateMonitorUrl('')).rejects.toBeInstanceOf(SSRFBlockedError);
    await expect(validateMonitorUrl(null)).rejects.toBeInstanceOf(SSRFBlockedError);
    await expect(validateMonitorUrl('http://')).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('rejects localhost and internal-only hostnames without DNS', async () => {
    await expect(validateMonitorUrl('http://localhost:3000')).rejects.toThrow(/not allowed/i);
    await expect(validateMonitorUrl('http://app.internal/health')).rejects.toThrow(/internal-only/i);
    await expect(validateMonitorUrl('http://printer.local')).rejects.toThrow(/internal-only/i);
    await expect(validateMonitorUrl('http://metadata.google.internal/')).rejects.toThrow(/not allowed/i);
  });

  it('rejects private literal IPs', async () => {
    await expect(validateMonitorUrl('http://127.0.0.1/')).rejects.toThrow(/reserved\/private/i);
    await expect(validateMonitorUrl('http://10.0.0.5/admin')).rejects.toThrow(/reserved\/private/i);
    await expect(validateMonitorUrl('http://192.168.0.1/')).rejects.toThrow(/reserved\/private/i);
    await expect(validateMonitorUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /reserved\/private/i
    );
    await expect(validateMonitorUrl('http://[::1]:5000/')).rejects.toThrow(/reserved\/private/i);
  });

  it('rejects sensitive internal service ports', async () => {
    await expect(validateMonitorUrl('http://8.8.8.8:22/')).rejects.toThrow(/port 22 is blocked/i);
    await expect(validateMonitorUrl('http://8.8.8.8:6379/')).rejects.toThrow(/6379 is blocked/i);
    await expect(validateMonitorUrl('http://8.8.8.8:27017/')).rejects.toThrow(/27017 is blocked/i);
  });
});

describe('DNS resolution checks', () => {
  let lookupSpy;

  beforeAll(() => {
    config.security.allowPrivateTargets = false;
  });

  afterEach(() => {
    if (lookupSpy) lookupSpy.mockRestore();
    lookupSpy = undefined;
  });

  afterAll(() => {
    config.security.allowPrivateTargets = true;
  });

  it('accepts a public hostname and returns the resolved address', async () => {
    lookupSpy = jest
      .spyOn(dnsPromises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const target = await resolveAndValidateTarget('https://example.com/health');

    expect(target.address).toBe('93.184.216.34');
    expect(target.hostname).toBe('example.com');
    expect(target.path).toBe('/health');
    expect(target.protocol).toBe('https:');
  });

  it('adds a default scheme when the user types a bare domain', async () => {
    lookupSpy = jest
      .spyOn(dnsPromises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const target = await resolveAndValidateTarget('example.com/api');
    expect(target.url).toBe('http://example.com/api');
    expect(target.port).toBe(80);
  });

  it('blocks a public-looking hostname that resolves to a private IP (DNS rebinding)', async () => {
    lookupSpy = jest
      .spyOn(dnsPromises, 'lookup')
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(validateMonitorUrl('http://totally-legit.example.com/')).rejects.toThrow(
      /reserved\/private/i
    );
  });

  it('blocks when only ONE of several DNS answers is private', async () => {
    lookupSpy = jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.1.1', family: 4 },
    ]);

    await expect(validateMonitorUrl('http://mixed.example.com/')).rejects.toThrow(
      /reserved\/private/i
    );
  });

  it('reports a DNS failure clearly', async () => {
    lookupSpy = jest
      .spyOn(dnsPromises, 'lookup')
      .mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

    await expect(validateMonitorUrl('http://does-not-exist.example/')).rejects.toThrow(
      /DNS lookup .* failed/i
    );
  });
});

describe('Redirect validation', () => {
  beforeAll(() => {
    config.security.allowPrivateTargets = false;
  });
  afterAll(() => {
    config.security.allowPrivateTargets = true;
  });

  it('blocks a redirect that points at the metadata service', async () => {
    await expect(
      validateRedirect('http://169.254.169.254/latest/meta-data/', 'http://8.8.8.8/start')
    ).rejects.toBeInstanceOf(SSRFBlockedError);
  });

  it('blocks a redirect to localhost', async () => {
    await expect(
      validateRedirect('http://127.0.0.1:8080/admin', 'http://8.8.8.8/start')
    ).rejects.toThrow(/reserved\/private/i);
  });

  it('blocks a redirect that changes to a non-http scheme', async () => {
    await expect(
      validateRedirect('file:///etc/passwd', 'http://8.8.8.8/start')
    ).rejects.toThrow(/http:\/\/ and https:\/\//i);
  });

  it('allows a normal relative redirect', async () => {
    const lookupSpy = jest
      .spyOn(dnsPromises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const target = await validateRedirect('/v2/health', 'https://example.com/v1/health');
    expect(target.url).toBe('https://example.com/v2/health');
    lookupSpy.mockRestore();
  });
});

describe('POST /api/monitors — SSRF blocked through the API', () => {
  beforeAll(() => {
    config.security.allowPrivateTargets = false;
  });
  afterAll(() => {
    config.security.allowPrivateTargets = true;
  });

  it('returns 400 for a localhost URL', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Internal', url: 'http://127.0.0.1:27017/', team: user.teamId });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/cannot be monitored/i);
  });

  it('returns 400 for the cloud metadata endpoint', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Metadata', url: 'http://169.254.169.254/', team: user.teamId });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a non-http scheme', async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .post('/api/monitors')
      .set(user.headers)
      .send({ name: 'Local file', url: 'file:///etc/passwd', team: user.teamId });

    expect(res.statusCode).toBe(400);
  });
});