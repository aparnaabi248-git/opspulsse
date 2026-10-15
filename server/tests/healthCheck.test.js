const { runHealthCheck, OUTCOMES } = require('../src/services/healthCheck');
const { startFixtureServer } = require('./helpers');

/**
 * Real HTTP checks.
 *
 * These run against a genuine local HTTP server (http.createServer + real
 * sockets). Nothing is mocked, so the response times, status codes and error
 * messages below are the actual values produced by the network stack.
 */

describe('Health check engine', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('reports UP for a healthy 200 response', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/health'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 5000,
    });

    expect(result.status).toBe('up');
    expect(result.statusCode).toBe(200);
    expect(result.outcome).toBe(OUTCOMES.OK);
    expect(result.errorMessage).toBeNull();
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.resolvedIp).toBe('127.0.0.1');
  });

  it('reports DOWN with the real status code when the server returns 500', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/error'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 5000,
    });

    expect(result.status).toBe('down');
    expect(result.statusCode).toBe(500);
    expect(result.errorMessage).toMatch(/Unexpected status code 500/);
  });

  it('reports DOWN when the status code is not in the expected list', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/wrong'),
      timeoutMs: 5000,
      expectedStatusCodes: [200, 204],
      degradedThresholdMs: 5000,
    });

    expect(result.status).toBe('down');
    expect(result.statusCode).toBe(404);
    expect(result.errorMessage).toMatch(/expected 200, 204/);
  });

  it('reports DEGRADED when the response is slower than the threshold', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/slow?ms=350'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 100,
    });

    expect(result.status).toBe('degraded');
    expect(result.statusCode).toBe(200);
    expect(result.degradedReason).toMatch(/exceeded the 100 ms threshold/);
  });

  it('reports UP when the expected response text is present', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/text'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      expectedBodyText: 'Everything is fine',
      degradedThresholdMs: 5000,
    });

    expect(result.status).toBe('up');
  });

  it('reports DOWN when the expected response text is missing', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/health'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      expectedBodyText: 'this text is not there',
      degradedThresholdMs: 5000,
    });

    expect(result.status).toBe('down');
    expect(result.errorMessage).toMatch(/expected text/i);
  });

  it('times out a hanging server and reports the real duration', async () => {
    const started = Date.now();
    const result = await runHealthCheck({
      url: fixture.url('/hang'),
      timeoutMs: 800,
      expectedStatusCodes: [200],
      degradedThresholdMs: 0,
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe('down');
    expect(result.outcome).toBe(OUTCOMES.TIMEOUT);
    expect(result.errorMessage).toMatch(/timed out after 800 ms/);
    expect(result.statusCode).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(3000);
  });

  it('reports a connection reset', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/reset'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 0,
    });

    expect(result.status).toBe('down');
    expect(result.outcome).toBe(OUTCOMES.FAILED);
    expect(result.errorMessage).toMatch(/reset|abort/i);
  });

  it('follows a redirect and records that it did', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/redirect?to=/health'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 5000,
    });

    expect(result.status).toBe('up');
    expect(result.redirected).toBe(true);
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toContain('/health');
  });

  it('stops after too many redirects', async () => {
    const result = await runHealthCheck({
      url: fixture.url('/redirect?to=/redirect?to=/redirect?to=/redirect?to=/redirect?to=/redirect?to=/redirect'),
      timeoutMs: 5000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 0,
    });

    expect(result.status).toBe('down');
    expect(result.errorMessage).toMatch(/Too many redirects/);
  });

  it('reports a DNS failure for a domain that cannot resolve', async () => {
    const result = await runHealthCheck({
      url: 'http://this-domain-does-not-exist-opspulse.invalid/',
      timeoutMs: 4000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 0,
    });

    expect(result.status).toBe('down');
    expect(result.errorMessage).toMatch(/DNS lookup failed|Blocked by security policy/);
  });

  it('reports a refused connection when nothing listens on the port', async () => {
    const result = await runHealthCheck({
      // Port 1 is blocked by the SSRF guard, so use the internal IP with a
      // high, closed port instead (tests run with private targets allowed)
      url: 'http://127.0.0.1:9/',
      timeoutMs: 4000,
      expectedStatusCodes: [200],
      degradedThresholdMs: 0,
    });

    expect(result.status).toBe('down');
    expect(result.errorMessage).toMatch(/refused|unreachable|reset|policy/i);
  });
});