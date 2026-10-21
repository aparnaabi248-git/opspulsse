const { redact, sanitizeError } = require('../src/utils/sanitizeError');

/**
 * The sanitizer is the only thing standing between the Mongo driver's error
 * text and the function logs. A connection string in a log is a credential
 * leak, so these tests assert on the redaction itself rather than on the
 * shape of the returned object.
 */

const SECRET = 'S3cr3t-P@ss';

describe('redact', () => {
  it('removes credentials from a mongodb+srv connection string', () => {
    const out = redact(`connect failed mongodb+srv://app:${SECRET}@cluster0.abc.mongodb.net/opspulse`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('app:');
    expect(out).toContain('<redacted>');
  });

  it('removes credentials from a mongodb connection string', () => {
    const out = redact(`Connection to mongodb://app:${SECRET}@db.example.com:27017/opspulse closed`);
    expect(out).not.toContain(SECRET);
    // The host stays — it is not a secret and tells you which cluster failed.
    expect(out).toContain('mongodb://<redacted>@db.example.com:27017/opspulse');
  });

  it('redacts credentials in a driver option dump', () => {
    const out = redact(`{ user: 'app', pass: '${SECRET}', authSource: 'admin' }`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('pass: <redacted>');
  });

  it('leaves ordinary text and host names alone', () => {
    const out = redact('Authentication failed.');
    expect(out).toBe('Authentication failed.');
  });

  it('handles null and undefined without throwing', () => {
    expect(redact(null)).toBe('');
    expect(redact(undefined)).toBe('');
    expect(redact(42)).toBe('42');
  });
});

describe('sanitizeError', () => {
  it('keeps the error name and driver code', () => {
    const out = sanitizeError({ name: 'MongoServerSelectionError', code: 133, message: 'boom' });
    expect(out.name).toBe('MongoServerSelectionError');
    expect(out.code).toBe(133);
    expect(out.message).toBe('boom');
  });

  it('redacts a secret that appears in the message', () => {
    const out = sanitizeError({
      name: 'MongoNetworkError',
      code: null,
      message: `could not connect to mongodb+srv://app:${SECRET}@cluster0.abc.mongodb.net/`,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.message).toContain('<redacted>');
  });

  it('redacts a secret that appears in the cause chain', () => {
    const out = sanitizeError({
      name: 'MongoServerSelectionError',
      code: 133,
      message: 'selection timed out',
      cause: {
        name: 'Error',
        message: `getaddrinfo ENOTFOUND cluster0.abc.mongodb.net for mongodb+srv://app:${SECRET}@cluster0.abc.mongodb.net/`,
      },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.cause.name).toBe('Error');
    expect(out.cause.message).toContain('<redacted>');
  });

  it('never includes the secret in any part of the result', () => {
    const out = sanitizeError(
      new Error(`bad auth mongodb+srv://app:${SECRET}@cluster0.abc.mongodb.net/opspulse`)
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('scrubs the real credentials even when the driver quotes a fragment', () => {
    // The driver can echo a piece of the credentials back; scrubbing with the
    // actual username/password from MONGO_URI catches what a regex cannot.
    const uri = `mongodb+srv://app-user:${SECRET}@cluster0.abc.mongodb.net/opspulse`;
    const out = sanitizeError(new Error(`could not connect as app-user to the cluster`), uri);
    expect(JSON.stringify(out)).not.toContain('app-user');
    expect(out.message).toContain('<redacted>');
  });

  it('scrubs credentials that appear in the cause chain', () => {
    const uri = `mongodb+srv://app-user:${SECRET}@cluster0.abc.mongodb.net/opspulse`;
    const out = sanitizeError(
      { name: 'MongoServerSelectionError', code: 133, message: 'timed out', cause: new Error(`auth as ${SECRET} failed`) },
      uri
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.cause.message).toContain('<redacted>');
  });

  it('tolerates input that is not an Error at all', () => {
    expect(sanitizeError(undefined).name).toBe('Error');
    expect(sanitizeError('just a string').message).toBe('just a string');
    expect(sanitizeError(null).code).toBeNull();
  });
});
