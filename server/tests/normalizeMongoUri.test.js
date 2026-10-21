const { normalizeMongoUri, encodeCredentials } = require('../src/utils/normalizeMongoUri');

/**
 * A connection string pasted into a dashboard env var is untrusted input.
 * These tests pin the three failure modes that all present as the same Atlas
 * "bad auth" error, and — just as important — assert that a URI which is
 * already correct is left byte-for-byte alone.
 */

describe('normalizeMongoUri', () => {
  it('returns non-strings untouched', () => {
    expect(normalizeMongoUri(undefined)).toBeUndefined();
    expect(normalizeMongoUri(null)).toBeNull();
    expect(normalizeMongoUri(42)).toBe(42);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeMongoUri('  mongodb://u:p@c.net/db  ')).toBe('mongodb://u:p@c.net/db');
    expect(normalizeMongoUri('\n\tmongodb://u:p@c.net/db\n')).toBe('mongodb://u:p@c.net/db');
  });

  it('strips a pair of surrounding double quotes', () => {
    expect(normalizeMongoUri('"mongodb+srv://u:p@c.net/db"')).toBe('mongodb+srv://u:p@c.net/db');
  });

  it('strips a pair of surrounding single quotes', () => {
    expect(normalizeMongoUri("'mongodb+srv://u:p@c.net/db'")).toBe('mongodb+srv://u:p@c.net/db');
  });

  it('leaves a correct, already-encoded URI unchanged', () => {
    const uri = 'mongodb+srv://app:P%40ss@cluster0.abc.mongodb.net/opspulse?authSource=admin&retryWrites=true';
    expect(normalizeMongoUri(uri)).toBe(uri);
  });

  it('is idempotent', () => {
    const raw = 'mongodb+srv://app:P@ss@cluster0.abc.mongodb.net/opspulse';
    const once = normalizeMongoUri(raw);
    expect(normalizeMongoUri(once)).toBe(once);
  });

  it('percent-encodes a raw @ inside the password', () => {
    expect(normalizeMongoUri('mongodb+srv://app:P@ss@cluster0.abc.mongodb.net/db'))
      .toBe('mongodb+srv://app:P%40ss@cluster0.abc.mongodb.net/db');
  });

  it('percent-encodes a raw / inside the password', () => {
    expect(normalizeMongoUri('mongodb://app:P/ass@db.example.com:27017/opspulse'))
      .toBe('mongodb://app:P%2Fass@db.example.com:27017/opspulse');
  });

  it('percent-encodes a raw ? inside the password without swallowing the query string', () => {
    expect(normalizeMongoUri('mongodb://app:p?ass@db.example.com/opspulse?retryWrites=true'))
      .toBe('mongodb://app:p%3Fass@db.example.com/opspulse?retryWrites=true');
  });

  it('percent-encodes a raw # inside the password', () => {
    expect(normalizeMongoUri('mongodb://app:p#ass@db.example.com/db'))
      .toBe('mongodb://app:p%23ass@db.example.com/db');
  });

  it('percent-encodes a raw : inside the password', () => {
    expect(normalizeMongoUri('mongodb://app:p:ass@db.example.com/db'))
      .toBe('mongodb://app:p%3Aass@db.example.com/db');
  });

  it('returns a URI with no credentials unchanged', () => {
    expect(normalizeMongoUri('mongodb://db.example.com:27017/opspulse'))
      .toBe('mongodb://db.example.com:27017/opspulse');
  });

  it('returns a username-only URI unchanged', () => {
    expect(normalizeMongoUri('mongodb://app@db.example.com/opspulse'))
      .toBe('mongodb://app@db.example.com/opspulse');
  });

  it('handles an empty password without adding characters', () => {
    expect(normalizeMongoUri('mongodb://app:@db.example.com/opspulse'))
      .toBe('mongodb://app:@db.example.com/opspulse');
  });

  it('leaves a non-MongoDB string alone', () => {
    expect(normalizeMongoUri('not a connection string')).toBe('not a connection string');
  });

  it('handles a stray % that is not a valid escape', () => {
    // decodeURIComponent would throw; the value must survive, not crash.
    expect(normalizeMongoUri('mongodb://app:100%done@db.example.com/db'))
      .toBe('mongodb://app:100%25done@db.example.com/db');
  });
});

describe('encodeCredentials', () => {
  it('returns the input unchanged when there is no scheme', () => {
    expect(encodeCredentials('u:p@host/db')).toBe('u:p@host/db');
  });
});
