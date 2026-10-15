/**
 * Test environment overrides.
 *
 * Runs before anything else so src/config picks these up instead of
 * server/.env. The production / dev databases are never touched.
 */
process.env.NODE_ENV = 'test';

// Never reuse a real secret
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-else-0123456789';
process.env.JWT_EXPIRES_IN = '1h';

// Dedicated test database (separate from opspulse / opspulse_dev)
process.env.MONGO_URI =
  process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/opspulse_test';

// The test suite starts local HTTP fixture servers on 127.0.0.1 to test the
// real health-check engine. SSRF protection against private ranges is tested
// separately in tests/ssrf.test.js, which turns this back off explicitly.
process.env.ALLOW_PRIVATE_TARGETS = 'true';

// Disable throttling so tests are not rate limited
process.env.RATE_LIMIT_AUTH_MAX = '100000';
process.env.RATE_LIMIT_API_MAX = '100000';

process.env.LOG_LEVEL = 'error';
process.env.SCHEDULER_ENABLED = 'false';